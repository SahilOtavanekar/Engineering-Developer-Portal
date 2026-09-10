import type { Scorer } from '../types';

/**
 * Branches this estate keeps on purpose, and which must not be counted as
 * neglect.
 *
 * Measured, not guessed. These are the long-lived branches CLAUDE.md records:
 * `stage` on 12 repositories carrying 355 commits, `staging` on 2 carrying
 * 156, `dev` on 6 carrying 139 and `dev-stage` on 1 carrying 100 -- roughly
 * **750 of the estate's 2,699 stranded commits**, none of which will ever merge
 * to main and none of which anybody should delete. Counting them would tell
 * twenty-odd teams to destroy their release process, which is how a scorecard
 * stops being believed.
 *
 * **`master` is deliberately absent**, though 2 repositories carry a stale one:
 * a `master` left behind by a rename to `main` is exactly the branch this rule
 * exists to catch. Where `master` is still the default branch it is excluded
 * anyway, by being the default.
 *
 * Nothing speculative is listed. `develop`, `uat`, `qa` and `release/*` are
 * conventional elsewhere and appear nowhere in this estate's stale branches, so
 * they are left for whoever actually has one to add -- a default that forgives
 * a branch nobody has is a silent hole in the metric.
 */
export const DEFAULT_STALE_BRANCH_EXEMPTIONS = [
  'stage',
  'staging',
  'dev',
  'dev-stage',
];

/**
 * The specification's bands, as fractions of this metric's weight.
 *
 * Counts, not ratios -- which is the substantive change from the branch-hygiene
 * metric this replaced. That one scored the *share* of branches touched
 * recently, so a repository with 2 branches and 1 stale scored 0.5 while one
 * with 20 branches and 1 stale scored 0.95. The rule being implemented says
 * stale branches should be removed; the number needing removal is the thing
 * that matters, not how many tidy branches sit beside them.
 *
 * Each entry states the points it is worth at the nominal weight of 15, which
 * is what the specification's table gives; fractions rather than absolute
 * points so the proportions survive a reweighting, since the engine multiplies
 * by the configured weight.
 */
const BANDS: Array<{ upTo: number; fraction: number }> = [
  { upTo: 0, fraction: 15 / 15 },
  { upTo: 2, fraction: 7 / 15 },
  { upTo: 5, fraction: 4 / 15 },
];

function bandFraction(stale: number): number {
  return BANDS.find(band => stale <= band.upTo)?.fraction ?? 0;
}

/**
 * How much abandoned work is lying around?
 *
 * Counts branches with no commit inside the staleness window, **excluding the
 * default branch and anything explicitly exempted**. The default branch cannot
 * be a stale branch somebody should delete whatever its age -- its staleness is
 * the main-branch metric's job -- and the exemptions exist because a real part
 * of this estate's stale count is a deliberate release process: see
 * `StaleBranchOptions`.
 *
 * **Zero stale branches earns full marks, including for a repository that has
 * only its default branch.** This reverses the old branch-hygiene reasoning,
 * which returned "unmeasurable" for a repository with no branches on the
 * grounds that full marks would flatter something empty. That was really a
 * guard against dividing by zero in a ratio; with a count there is no division,
 * and "no branches need deleting" is a true and complete measurement. An empty
 * repository is already answered by the recency and README metrics, which is
 * where it should be answered.
 *
 * Unmeasurable only when the branch pass has not covered the repository at all,
 * which is not the same as having nothing to delete.
 */
export function staleBranchesScorer(): Scorer {
  return {
    id: 'stale-branches',
    // **"Stale branches", not the specification's rule name "No stale
    // branches".** A rule heading asserts the desired state; a scorecard row
    // labels the thing being measured, and its detail sits right beside it.
    // Found in the browser rather than reasoned about: the row read "No stale
    // branches -- 5 branches with no commit in 90 days", a flat contradiction.
    // The other titles survive that reading ("README available -- No README at
    // the repository root") because they do not assert a negative.
    title: 'Stale branches',
    score({ branches, windowDays }) {
      if (!branches) return null;

      const { staleActionable, staleExempt } = branches;
      const exemptNote =
        staleExempt > 0
          ? `, ${staleExempt} exempt from the count as deliberate`
          : '';

      if (staleActionable === 0) {
        return {
          fraction: 1,
          // "None need deleting" rather than "No stale branches", which beside
          // a row now titled "Stale branches" would just say the same thing
          // twice.
          detail:
            staleExempt > 0
              ? `None need deleting (${staleExempt} exempt as deliberate)`
              : 'None need deleting',
        };
      }

      return {
        fraction: bandFraction(staleActionable),
        detail: `${staleActionable} branch${
          staleActionable === 1 ? '' : 'es'
        } with no commit in ${windowDays} days${exemptNote}`,
        // Quotes counts and the window, never points: the weight is
        // configurable and is currently an interim figure, so an absolute
        // number here would be wrong on the page today.
        remediation:
          `Delete the ${staleActionable} branch${
            staleActionable === 1 ? '' : 'es'
          } nothing has touched in ${windowDays} days, or add ${
            staleActionable === 1 ? 'it' : 'the deliberate ones'
          } to fleet.scoring.metrics.staleBranches.exempt. ` +
          `Full marks needs none left; 1-2 still earns roughly half and 3-5 a quarter.`,
      };
    },
  };
}
