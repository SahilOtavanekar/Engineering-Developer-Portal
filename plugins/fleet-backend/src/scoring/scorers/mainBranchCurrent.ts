import type { Scorer } from '../types';
import { describeAge, recencyLadder, type RecencyBand } from './recency';

export interface MainBranchCurrentOptions {
  /**
   * The day ladder, ascending. Defaults to the specification's table: a commit
   * within 30 days earns 20, 31-60 days earns 7, 61-90 days earns 3, and
   * anything older earns nothing.
   */
  bands?: RecencyBand[];
}

export const DEFAULT_MAIN_BRANCH_BANDS: RecencyBand[] = [
  { withinDays: 30, points: 20 },
  { withinDays: 60, points: 7 },
  { withinDays: 90, points: 3 },
];

/**
 * Does the main branch reflect recent work?
 *
 * **Measured on the default branch alone, which is the whole point of having
 * this separately from `activeDevelopment`.** `CommitIngestionService` passes
 * `branch: repository.default_branch`, so every commit the portal stores is one
 * that reached main -- which makes `activity.lastCommitAt` exactly the field
 * this rule asks about, at no extra cost. Work sitting on a feature branch does
 * not count here, and is deliberately counted by the other metric: measured
 * 2026-09-09, **22 of 98 repositories have branch activity more than a week
 * ahead of main**, and those are precisely the ones where work is happening but
 * nothing is landing. One timestamp for both rules would have hidden all 22.
 *
 * A repository that has never had a commit on main scores zero rather than
 * being unmeasurable -- the bottom rung of the ladder is "no commit for more
 * than 90 days", and never having had one satisfies it. `deriveProblems` is
 * what then decides whether to call that a scaffold or an abandoned service,
 * using lifetime commit counts a scorer cannot see.
 */
export function mainBranchCurrentScorer(
  options: MainBranchCurrentOptions = {},
): Scorer {
  const bands = options.bands ?? DEFAULT_MAIN_BRANCH_BANDS;
  const freshDays = bands[0]?.withinDays ?? 30;

  return {
    id: 'main-branch-current',
    title: 'Main branch up to date',
    score({ activity, repository, now }) {
      const branch = repository.default_branch ?? 'the default branch';
      const { fraction, ageDays } = recencyLadder(
        activity.lastCommitAt,
        now,
        bands,
      );

      if (ageDays === undefined) {
        return {
          fraction: 0,
          detail: `No commit has ever reached ${branch}`,
          // Nothing useful to say. A repository with no commits at all is
          // either a scaffold nobody started or a service that was never
          // imported, and "commit something" answers neither -- the same
          // reason `activeDevelopment` stays silent. The card reports it as
          // dormancy instead.
        };
      }

      return {
        fraction,
        detail: `Last commit to ${branch} ${describeAge(ageDays)}`,
        // Quotes the day threshold, never the points: the weight is
        // configurable, so naming "the full 20" would be wrong the moment
        // somebody retuned it -- and it is wrong right now, while the weight
        // is still the interim one.
        remediation:
          fraction >= 1
            ? undefined
            : `Land work on ${branch} at least every ${freshDays} days to earn full marks; the last commit there was ${describeAge(
                ageDays,
              )}.`,
      };
    },
  };
}
