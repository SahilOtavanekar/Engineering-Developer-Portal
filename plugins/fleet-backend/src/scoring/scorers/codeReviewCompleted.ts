import type { Scorer } from '../types';

/**
 * Is work being reviewed before it lands?
 *
 * The fraction of merged pull requests carrying at least one approval. Measured
 * on approvals rather than assigned reviewers: naming a reviewer who never
 * responds is not a review, and self-merges are exactly what this should catch.
 *
 * A repository with no merged pull requests in the window is unmeasurable, not
 * failing -- it may simply commit straight to its default branch, which the
 * branch and commit metrics already speak to.
 */
export function codeReviewCompletedScorer(): Scorer {
  return {
    id: 'code-review-completed',
    title: 'Code review completed',
    score({ reviews, windowDays }) {
      if (!reviews || reviews.merged === 0) {
        return null;
      }

      const { approved, merged } = reviews;
      return {
        fraction: approved / merged,
        detail: `${approved} of ${merged} merged PR${
          merged === 1 ? '' : 's'
        } approved in ${windowDays} days`,
      };
    },
  };
}
