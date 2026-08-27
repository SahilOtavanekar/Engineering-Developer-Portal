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
 * What share of the work landing on the default branch went through a pull
 * request.
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
    title: 'Changes land through pull requests',
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

      const merges = directMerge > 0 ? `, ${directMerge} of them merges` : '';
      return {
        fraction,
        detail:
          `${directTotal} direct commit${directTotal === 1 ? '' : 's'} to ` +
          `${branch} in ${windowDays} days${merges} — ` +
          `${viaPullRequest} of ${mainline} came through a pull request`,
      };
    },
  };
}
