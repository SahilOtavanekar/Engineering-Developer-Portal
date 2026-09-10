import type { Scorer } from '../types';

export interface PullRequestDisciplineOptions {
  /**
   * Window in days.
   *
   * Deliberately shorter than the 90 days the activity scorers use. Direct
   * commits to default branches on this estate fell from 7.8 a day to 0.38 a
   * day around 2026-07-27, so a 90-day count is mostly a report on behaviour
   * that has already changed: 380 direct commits across 33 repositories over 90
   * days, against 16 across 8 over 30. The shorter window measures the problem
   * that is still live.
   */
  windowDays?: number;
}

export const DEFAULT_DISCIPLINE_WINDOW_DAYS = 30;

/**
 * The specification's bands, as fractions of this metric's weight.
 *
 * Each entry states the points it is worth at the nominal weight of 20, which
 * is what the specification's table gives; fractions rather than absolute
 * points so the proportions survive a reweighting, since the engine multiplies
 * by the configured weight.
 *
 * **The two middle bands are unreachable for most of this estate, and that is
 * arithmetic rather than a defect.** 95-99% requires at least 20 mainline
 * commits in the window to be expressible at all. Measured 2026-09-09 over 30
 * days: 32 repositories are at 100%, 9 are below 80%, and **not one falls in
 * either middle band**. So in practice this metric pays 20 or 0 here. It will
 * start to discriminate as repositories get busier, which is why the bands are
 * implemented rather than collapsed to a pass/fail.
 */
const BANDS: Array<{ atLeast: number; fraction: number }> = [
  { atLeast: 0.95, fraction: 7 / 20 },
  { atLeast: 0.8, fraction: 3 / 20 },
  { atLeast: 0, fraction: 0 },
];

/**
 * How work reaches the default branch: through a branch and a pull request, or
 * straight onto main.
 *
 * **Squash-safe, and that matters more than it looks.** 178 of this estate's
 * 346 merged pull requests (51%) leave no merge commit -- squashed or
 * fast-forwarded -- and a squash rewrites the branch's commits into one, so
 * the originals are unreachable from main and never ingested. Counting
 * `merged-in` commits against `direct` ones would therefore report every
 * squash-merging team as pushing straight to main, penalising the better
 * practice. This scores `viaPullRequest` instead, which `BranchPolicyService`
 * derives by matching the pull request's merge hash: 91 of 219 mainline
 * commits attributed to a pull request here have a single parent, and every
 * one of those is a squash that a parent-count rule would have missed.
 *
 * **Banded, and the top band demands perfection.** The specification awards the
 * full 20 only for 100% -- a single direct commit costs 13 of them, dropping to
 * the 80-94% band -- then 7 for 95-99%, 3 for 80-94% and nothing below. This
 * replaced a linear share, which gave a repository at 95% almost full marks;
 * the rule being scored is "no direct commits should be made to the main
 * branch", and a graded reading of that let a team be mostly compliant for
 * almost all of the credit.
 *
 * Returns `null`, not zero, in two cases that are not failures:
 *
 * - the classification pass has not covered this repository yet
 * - nothing landed on the branch in the window, so there is nothing to judge --
 *   48 of 95 repositories here are dormant and are already penalised for that
 *   by the activity scorers
 */
export function pullRequestDisciplineScorer(
  options: PullRequestDisciplineOptions = {},
): Scorer {
  const windowDays = options.windowDays ?? DEFAULT_DISCIPLINE_WINDOW_DAYS;

  return {
    id: 'pull-request-discipline',
    // **"Changes through pull requests", not "Main branch health".** The old
    // title said nothing about what is measured, and once the scorecard was
    // trimmed to the requirement's seven rules it sat directly beneath "Main
    // branch up to date" -- two adjacent rows whose names differ by one word
    // and which measure entirely different things. Found by reading the
    // rendered card, which is the only place the collision was visible.
    // The id is unchanged, so stored breakdowns and filters still match.
    title: 'Changes through pull requests',
    score: ({ branchPolicy }) => {
      if (!branchPolicy) return null;

      const { mainline, viaPullRequest, direct, directMerge } = branchPolicy;
      if (mainline === 0) return null;

      const directTotal = direct + directMerge;
      const share = viaPullRequest / mainline;
      const branch = branchPolicy.branch ?? 'the default branch';

      // Exact equality for the top band rather than `share >= 1`: the point of
      // the rule is that nothing bypassed a pull request, and an integer
      // comparison says that without depending on how the division rounds.
      const fraction =
        viaPullRequest === mainline
          ? 1
          : BANDS.find(band => share >= band.atLeast)?.fraction ?? 0;

      if (directTotal === 0) {
        return {
          fraction: 1,
          detail:
            `all ${mainline} commit${mainline === 1 ? '' : 's'} on ${branch} ` +
            `came through a pull request in ${windowDays} days`,
        };
      }

      // The three ways work reaches main, stated separately. Merged-without-a-
      // pull-request and written-straight-on-main are different problems with
      // different fixes, and reporting one total for both hides which you have.
      const split = [
        `${viaPullRequest} through a pull request`,
        directMerge > 0
          ? `${directMerge} merged from a branch with no pull request`
          : undefined,
        direct > 0 ? `${direct} written directly on ${branch}` : undefined,
      ]
        .filter(Boolean)
        .join(', ');

      // Hoisted rather than inlined: concatenating a conditional expression
      // onto a string trips `prefer-template`, where two template literals
      // joined with `+` do not.
      const mergeNote =
        directMerge > 0
          ? ` ${directMerge} of those were merges with no pull request behind them, usually a local merge pushed straight up.`
          : '';
      // Names the whole band table rather than just the next rung: the gap to
      // full marks is usually the whole way, since only 100% earns it, so
      // "get to 95%" would understate what the metric is asking for.
      //
      // Stated as shares of the metric rather than as absolute points. The
      // weight is configurable -- and is currently an interim figure -- so
      // naming "20 points" would be wrong on the page today and wrong again
      // the moment anybody retuned it.
      return {
        fraction,
        remediation:
          `Land every change on ${branch} through a pull request, and protect ` +
          `the branch with Bitbucket branch restrictions so it cannot be ` +
          `bypassed. ${directTotal} of the last ${mainline} mainline commits ` +
          `did not go through one.${mergeNote} Only 100% earns full marks; ` +
          `95-99% earns just over a third of them and 80-94% earns a seventh.`,
        detail:
          `${mainline} commit${mainline === 1 ? '' : 's'} reached ${branch} ` +
          `in ${windowDays} days: ${split}`,
      };
    },
  };
}
