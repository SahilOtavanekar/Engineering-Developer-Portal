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
 * Graded rather than pass/fail: one direct commit among fifty is a slip, and
 * eleven out of eleven is a repository with no review at all. Scoring both zero
 * would tell the second team nothing about how far they have to go.
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
    title: 'Main branch health',
    score: ({ branchPolicy }) => {
      if (!branchPolicy) return null;

      const { mainline, viaPullRequest, direct, directMerge } = branchPolicy;
      if (mainline === 0) return null;

      const directTotal = direct + directMerge;
      const fraction = viaPullRequest / mainline;
      const branch = branchPolicy.branch ?? 'the default branch';

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
      return {
        fraction,
        remediation:
          `Land changes on ${branch} through a pull request. ` +
          `${directTotal} of the last ${mainline} mainline commits did not.${mergeNote}`,
        detail:
          `${mainline} commit${mainline === 1 ? '' : 's'} reached ${branch} ` +
          `in ${windowDays} days: ${split}`,
      };
    },
  };
}
