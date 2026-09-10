import type { Scorer } from '../types';
import { describeAge, recencyLadder, type RecencyBand } from './recency';

export interface ActiveDevelopmentOptions {
  /**
   * The day ladder, ascending. Defaults to the specification's table: activity
   * within 30 days earns 10, 31-60 days earns 7, 61-90 days earns 3, and
   * anything older earns nothing.
   *
   * Note the shape differs from the main-branch ladder even though the day
   * boundaries are identical: 10/7/3 falls away far more gently than 20/7/3, so
   * a repository that has merely slowed down loses much less here than one
   * whose main branch has gone quiet.
   */
  bands?: RecencyBand[];
}

export const DEFAULT_ACTIVE_DEVELOPMENT_BANDS: RecencyBand[] = [
  { withinDays: 30, points: 10 },
  { withinDays: 60, points: 7 },
  { withinDays: 90, points: 3 },
];

/**
 * Is anybody still working on this repository, anywhere in it?
 *
 * **Repository-wide, where `mainBranchCurrent` is default-branch only.** The
 * newest commit on *any* branch, so a team working on a feature branch that has
 * not landed yet reads as active here while main correctly reads as stale.
 * Measured 2026-09-09: 44 repositories have activity within 30 days on some
 * branch against 41 on main, and **38 are quiet everywhere against 44 whose
 * main is quiet** -- so six repositories are distinguished by this metric alone,
 * and 22 have branch activity more than a week ahead of main.
 *
 * Costs nothing extra: `BranchStore.summary` already reads every branch's
 * `last_commit_at` to count stale ones, so it returns the newest of them on the
 * same query.
 *
 * **Falls back to the default branch when branches have not been ingested.**
 * `branches` is absent until the branch pass has covered the repository, and
 * without the fallback this would score a busy repository zero on its first
 * pass. The fallback can only ever understate activity, never overstate it,
 * because main's newest commit is by definition one of the candidates.
 */
export function activeDevelopmentScorer(
  options: ActiveDevelopmentOptions = {},
): Scorer {
  const bands = options.bands ?? DEFAULT_ACTIVE_DEVELOPMENT_BANDS;
  const freshDays = bands[0]?.withinDays ?? 30;

  return {
    id: 'active-development',
    title: 'Active development',
    score({ activity, branches, now }) {
      // The newest of every branch head and of main itself. `Math.max` over
      // timestamps rather than a comparison chain, so adding a third source
      // later is one more entry rather than another branch of logic.
      const candidates = [activity.lastCommitAt, branches?.lastCommitAt]
        .filter((at): at is Date => Boolean(at))
        .map(at => new Date(at).getTime());

      const newest =
        candidates.length > 0 ? new Date(Math.max(...candidates)) : null;

      const { fraction, ageDays } = recencyLadder(newest, now, bands);

      if (ageDays === undefined) {
        return {
          fraction: 0,
          detail: 'No commit on any branch',
          // Deliberately silent, as the old activity metric was: telling a
          // four-commit scaffold and an abandoned 276-commit service the same
          // thing ("commit more") answers neither. `deriveProblems` separates
          // them by lifetime commits and phrases the dormancy itself.
        };
      }

      // Whether the newest work is on main or on a side branch, because the two
      // mean different things to whoever reads it: a repository active only on
      // a branch has work that is not shipping.
      const onMain =
        activity.lastCommitAt !== null &&
        newest !== null &&
        new Date(activity.lastCommitAt).getTime() === newest.getTime();

      // **Only said when main is itself behind.** Found by reading the stored
      // details rather than by reasoning: `demand-ai-website` has a commit on
      // main *today* and a branch head a few seconds newer, and the note
      // therefore read "on a branch, not the default one" about a repository
      // whose main branch is perfectly current -- which implies a shipping
      // problem that does not exist. The note exists to say that credited
      // activity is not reaching main, so it is worth nothing when it is.
      // Reuses the ladder rather than recomputing an age, so the two can
      // never disagree about where the boundary is.
      const mainIsBehind =
        recencyLadder(activity.lastCommitAt, now, bands).fraction < 1;
      const where =
        !onMain && mainIsBehind ? ' (on a branch, not the default one)' : '';

      return {
        fraction,
        detail: `Last commit ${describeAge(ageDays)}${where}`,
        remediation:
          fraction >= 1
            ? undefined
            : `Any commit inside ${freshDays} days earns full marks; the newest anywhere in this repository is ${describeAge(
                ageDays,
              )}.`,
      };
    },
  };
}
