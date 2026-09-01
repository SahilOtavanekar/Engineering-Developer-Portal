import type {
  LifetimeSummaryView,
  RepositoryScoreSummary,
  ScoreBreakdownEntry,
} from './types';

/**
 * Metrics that are all the same fact wearing different hats.
 *
 * A repository with no commits in the window scores zero on commits, zero on
 * contributors and zero on branch hygiene -- because there were no commits, no
 * committers and no branches touched. Reporting three problems for one fact is
 * noise, and on this estate it would be noise 48 times over.
 *
 * So when the repository is dormant these are folded into a single statement
 * about dormancy, and only the genuinely independent gaps -- README, owner,
 * pipelines, review -- are reported as problems a team can act on.
 */
const ACTIVITY_DERIVED = new Set([
  'active-commits',
  'active-contributors',
  'branch-hygiene',
]);

/** The metric whose zero defines dormancy. */
const ACTIVITY_METRIC = 'active-commits';

/**
 * A repository with ten or fewer commits in its whole life was never really
 * developed.
 *
 * Measured: 42 of the 59 repositories below healthy are in this state. Telling
 * their teams "no commits in 90 days" describes a scaffold as a decaying
 * service, which is how a warning gets ignored.
 */
const NEVER_STARTED_COMMITS = 10;

export type ProblemKind =
  /** A gap the team can close. */
  | 'actionable'
  /** Cannot be judged, and must not be counted against the repository. */
  | 'unmeasured';

export interface Problem {
  id: string;
  title: string;
  /** The scorer's own explanation, e.g. '2 of 5 recent runs passed'. */
  detail: string;
  /**
   * What would close the gap, supplied by the scorer.
   *
   * Absent on scores computed before remediation existed, and absent wherever
   * the scorer had nothing useful to say -- notably `active-commits` on a
   * repository with no commits at all, where "commit more" answers neither the
   * scaffold case nor the abandoned one.
   */
  remediation?: string;
  /** Points forfeited. Zero for an unmeasured metric. */
  lost: number;
  weight: number;
  kind: ProblemKind;
}

export type DormancyKind =
  /** Barely any commits ever. A scaffold, not a failure. */
  | 'never-started'
  /** Real history, then nothing. The signal worth acting on. */
  | 'abandoned';

export interface Dormancy {
  kind: DormancyKind;
  lifetimeCommits?: number;
  lastCommitAt?: string;
}

export interface RepositoryProblems {
  /** Worst first, by points lost. */
  actionable: Problem[];
  /** Present only when nothing landed in the activity window. */
  dormancy?: Dormancy;
  /** Metrics with no data to judge, kept separate from failures. */
  unmeasured: Problem[];
  /** Total points forfeited by actionable problems. */
  lostPoints: number;
}

/**
 * How each metric reads when it is a problem rather than a measurement.
 *
 * The scorer's own title names the thing being measured -- "Pipeline passing"
 * -- which is right on a scorecard and actively misleading on a list of what is
 * wrong. A filter chip reading "Pipeline passing (37)" looks like 37
 * repositories whose pipelines pass; it means exactly the opposite.
 *
 * Applied to actionable problems only. An unmeasured metric keeps its neutral
 * title, because "Code review not completed" would assert a failure where the
 * portal has nothing to judge -- 55 repositories have no merged pull requests
 * at all, and none of them has failed to review anything.
 */
const PROBLEM_TITLES: Record<string, string> = {
  'active-commits': 'Not enough commits',
  'active-contributors': 'Not enough contributors',
  'branch-hygiene': 'Stale branches',
  'code-review-completed': 'Code review not completed',
  'owner-assigned': 'Owner not assigned',
  'pipeline-passing': 'Pipeline not passing',
  'pull-request-discipline': 'Changes bypassing pull requests',
  'readme-available': 'README not available',
};

/**
 * The problem phrasing for a metric, falling back to its own title.
 *
 * The fallback matters: a scorer registered later still produces a named
 * problem rather than a blank chip, and the omission shows up as odd wording
 * rather than as a crash.
 */
function problemTitle(entry: ScoreBreakdownEntry): string {
  return PROBLEM_TITLES[entry.id] ?? entry.title;
}

function lostFor(entry: ScoreBreakdownEntry): number {
  return Math.max(0, entry.weight - (entry.points ?? 0));
}

/**
 * Turns a score breakdown into problems worth showing.
 *
 * Deliberately derived rather than stored: everything here comes from the
 * breakdown the scoring pass already writes, so this needed no migration, no
 * new pass and no Bitbucket requests. The cost of that is that the wording
 * cannot mention a configured target -- the frontend does not know what
 * `activeCommits.target` is set to -- so remediation text is left for later
 * rather than guessed at here.
 */
export function deriveProblems(
  score: RepositoryScoreSummary | undefined,
  lifetime?: LifetimeSummaryView,
): RepositoryProblems {
  const empty: RepositoryProblems = {
    actionable: [],
    unmeasured: [],
    lostPoints: 0,
  };
  if (!score?.breakdown?.length) return empty;

  const unmeasured: Problem[] = score.breakdown
    .filter(entry => !entry.available)
    .map(entry => ({
      id: entry.id,
      title: entry.title,
      detail: entry.detail,
      lost: 0,
      weight: entry.weight,
      kind: 'unmeasured' as const,
    }));

  const measured = score.breakdown.filter(entry => entry.available);
  const activity = measured.find(entry => entry.id === ACTIVITY_METRIC);
  const isDormant = activity !== undefined && (activity.points ?? 0) === 0;

  const dormancy: Dormancy | undefined = isDormant
    ? {
        kind:
          (lifetime?.commits ?? 0) > NEVER_STARTED_COMMITS
            ? 'abandoned'
            : 'never-started',
        lifetimeCommits: lifetime?.commits,
        lastCommitAt: lifetime?.lastCommitAt,
      }
    : undefined;

  const actionable = measured
    .filter(entry => lostFor(entry) > 0)
    // When dormant, the activity metrics restate the dormancy rather than
    // adding anything.
    .filter(entry => !(isDormant && ACTIVITY_DERIVED.has(entry.id)))
    .map(entry => ({
      id: entry.id,
      title: problemTitle(entry),
      detail: entry.detail,
      remediation: entry.remediation,
      lost: lostFor(entry),
      weight: entry.weight,
      kind: 'actionable' as const,
    }))
    // Biggest forfeit first: a 20-weight metric at zero outranks a 10-weight
    // one, whatever order the engine happened to register them in.
    .sort(
      (a, b) =>
        b.lost - a.lost ||
        b.weight - a.weight ||
        a.title.localeCompare(b.title),
    );

  return {
    actionable,
    dormancy,
    unmeasured,
    lostPoints: actionable.reduce((total, problem) => total + problem.lost, 0),
  };
}

/**
 * Whether to lead with problems rather than leave them in the breakdown.
 *
 * Only below healthy. A healthy repository with one small gap does not need a
 * banner, and putting one there would train people to ignore it.
 */
export function shouldHighlightProblems(
  score: RepositoryScoreSummary | undefined,
): boolean {
  return Boolean(score) && score!.band !== 'healthy';
}

/** One line describing why the repository is quiet, phrased by its history. */
export function describeDormancy(
  dormancy: Dormancy,
  windowDays: number,
): string {
  const commits = dormancy.lifetimeCommits;
  if (dormancy.kind === 'abandoned') {
    return commits !== undefined
      ? `Abandoned: ${commits} commits in its history, none in the last ${windowDays} days.`
      : `Abandoned: real history, but nothing in the last ${windowDays} days.`;
  }
  return commits !== undefined
    ? `Never really developed: ${commits} commit${
        commits === 1 ? '' : 's'
      } in its whole history. Not a decaying service.`
    : `Never really developed. Not a decaying service.`;
}
