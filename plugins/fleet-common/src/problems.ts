import { isSatisfactoryBand } from './bands';
import type {
  LifetimeSummaryView,
  RepositoryScoreSummary,
  ScoreBreakdownEntry,
} from './types';

/**
 * Metrics that are all the same fact wearing different hats.
 *
 * A repository nobody has touched in 90 days scores zero on main-branch
 * recency, zero on development activity, zero on contributors and badly on
 * branch hygiene -- because there were no commits, no committers and no
 * branches touched. Reporting four problems for one fact is noise, and on this
 * estate it would be noise 38 times over.
 *
 * So when the repository is dormant these are folded into a single statement
 * about dormancy, and only the genuinely independent gaps -- README, owner,
 * pipelines, review -- are reported as problems a team can act on.
 */
const ACTIVITY_DERIVED = new Set([
  'main-branch-current',
  'active-development',
  'active-contributors',
  'stale-branches',
  // The retired ratio-based branch metric, and the retired commit-volume one. Kept because breakdowns are stored JSON
  // and a score row written before it was replaced still carries an entry
  // under this id, which would otherwise be reported as a problem of its own
  // beside the dormancy statement that supersedes it.
  'branch-hygiene',
  'active-commits',
]);

/**
 * The metric whose zero defines dormancy.
 *
 * `active-development` rather than the main-branch metric, and the distinction
 * matters: main going quiet while a feature branch is busy is a **shipping**
 * problem the team should be told about, not dormancy. Only when nothing has
 * happened anywhere in the repository is it genuinely dormant. Measured
 * 2026-09-09, that separates 38 dormant repositories from the 44 whose main
 * branch is stale.
 */
const ACTIVITY_METRIC = 'active-development';

/**
 * The id the dormancy trigger used to live on.
 *
 * Read as a fallback so a score row written before the recency metrics landed
 * still classifies as dormant. Without it, every repository would lose its
 * dormancy statement for one scoring cycle and then regain it, which reads as
 * a portal defect rather than as a deployment.
 */
const LEGACY_ACTIVITY_METRIC = 'active-commits';

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
  // Retired, and kept for the same reason it stays in `ACTIVITY_DERIVED`:
  // stored breakdowns outlive the scorer that wrote them.
  'active-commits': 'Not enough commits',
  'active-contributors': 'Not enough contributors',
  'active-development': 'No recent development',
  'branch-hygiene': 'Stale branches',
  'stale-branches': 'Stale branches',
  'main-branch-current': 'Main branch out of date',
  'code-review-completed': 'Code review not completed',
  'owner-assigned': 'Owner not assigned',
  'pipeline-passing': 'Pipeline not passing',
  'pull-request-discipline': 'Changes bypassing pull requests',
  'readme-available': 'README not available',
};

/**
 * Metrics **no** repository can be scored on, because the portal cannot measure
 * them at all.
 *
 * A scorer returning `null` carries no reason with it, so the breakdown cannot
 * say whether a metric went unmeasured because this repository has no data or
 * because nothing has been built to measure it. Those are opposite messages: the
 * first is the repository's to act on, the second is ours, and reporting the
 * second as the first sends a team hunting data that exists and that nothing has
 * asked Bitbucket for.
 *
 * **Empty today, and that is the good outcome.** `pull-request-size` was the
 * only entry, and it left when `PullRequestSizeService` landed the diffstat --
 * every registered metric now has a data source. The set is kept rather than
 * removed because it is the mechanism for the next deferred requirement, and
 * because losing it would take the *distinction* with it: a scorer returning
 * `null` still carries no reason, so without somewhere to record which
 * absences are ours, the card would go back to blaming a repository for the
 * portal's gaps.
 *
 * A metric here should also be registered rather than omitted, so its
 * forfeited weight stays visible.
 */
const PORTAL_CANNOT_MEASURE = new Set<string>([]);

/**
 * Whether an unmeasured metric is the portal's gap rather than the
 * repository's.
 */
export function isPortalGap(metricId: string): boolean {
  return PORTAL_CANNOT_MEASURE.has(metricId);
}

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
  const activity =
    measured.find(entry => entry.id === ACTIVITY_METRIC) ??
    measured.find(entry => entry.id === LEGACY_ACTIVITY_METRIC);
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
 * Only below Healthy -- see `isSatisfactoryBand`, which is where Excellent is
 * accounted for. A satisfactory repository with one small gap does not need a
 * banner, and putting one there would train people to ignore it.
 */
export function shouldHighlightProblems(
  score: RepositoryScoreSummary | undefined,
): boolean {
  return Boolean(score) && !isSatisfactoryBand(score!.band);
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
