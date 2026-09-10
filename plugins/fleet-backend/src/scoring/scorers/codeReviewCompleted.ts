import type { Scorer } from '../types';

export interface CodeReviewCompletedOptions {
  /**
   * Whether an approval by the pull request's own author counts as a review.
   *
   * Defaults to **false**, which is the specification's recommended baseline
   * ("Author cannot approve own PR") and the plain meaning of the rule it
   * scores: "PRs should receive peer review before merging". A self-approval is
   * not peer review.
   *
   * It is configuration rather than a constant because of how much it moves.
   * Measured 2026-09-09 over the 365 pull requests merged in 90 days: 265
   * carried an approval, **85 carried one from anybody other than the author**.
   * Counting only peer approvals takes 20 repositories from full marks to zero
   * on a 15-point metric, so somebody with authority should be able to reverse
   * it without a deploy.
   */
  countSelfApprovals?: boolean;
}

/**
 * The specification's bands, as fractions of this metric's weight.
 *
 * Written as the division rather than as a decimal so each entry states the
 * points it is worth at the nominal weight of 15, which is what the
 * specification's table gives. Expressing them as fractions is what keeps the
 * proportions intact if somebody reweights the metric -- the engine multiplies
 * a fraction by the configured weight, so a hardcoded 7 would silently become
 * a different share of a different total.
 */
const BANDS: Array<{ atLeast: number; fraction: number }> = [
  { atLeast: 0.9, fraction: 15 / 15 },
  { atLeast: 0.7, fraction: 7 / 15 },
  { atLeast: 0, fraction: 0 },
];

function bandFraction(share: number): number {
  return BANDS.find(band => share >= band.atLeast)?.fraction ?? 0;
}

/**
 * Is work being reviewed before it lands?
 *
 * **Banded, not graded.** The specification scores 90% or better at full marks,
 * 70-89% at 7 of 15 and anything below at nothing, so a repository reviewing
 * 89% of its pull requests earns less than half of one reviewing 90%. That is a
 * sharper incentive than the linear share this used to award, and it is
 * deliberate.
 *
 * Measured on approvals rather than assigned reviewers -- naming a reviewer who
 * never responds is not a review -- and by default on approvals from somebody
 * **other than the author**, which is what makes it a measure of review rather
 * than of a button being pressed. See {@link CodeReviewCompletedOptions}.
 *
 * A repository with no merged pull requests in the window is unmeasurable, not
 * failing: it may simply commit straight to its default branch, which the
 * main-branch metric already speaks to. 54 of this estate's repositories are in
 * that position.
 */
export function codeReviewCompletedScorer(
  options: CodeReviewCompletedOptions = {},
): Scorer {
  const countSelfApprovals = options.countSelfApprovals ?? false;

  return {
    id: 'code-review-completed',
    title: 'Code review completed',
    score({ reviews, windowDays }) {
      if (!reviews || reviews.merged === 0) {
        return null;
      }

      const { merged, approved, peerApproved } = reviews;
      const reviewed = countSelfApprovals ? approved : peerApproved;
      const share = reviewed / merged;
      const basis = countSelfApprovals
        ? 'approved'
        : 'reviewed by somebody else';

      // Self-approvals are only worth naming when they are the difference
      // between the two figures, and only when they are not being counted --
      // otherwise the sentence explains a gap that is not there.
      const selfApprovals = approved - peerApproved;
      const selfNote =
        !countSelfApprovals && selfApprovals > 0
          ? ` ${selfApprovals} more carried only the author's own approval, which is not a review.`
          : '';

      return {
        fraction: bandFraction(share),
        remediation:
          share >= 0.9
            ? undefined
            : `Have a second person approve before merging. ${reviewed} of ${merged} merged pull requests were ${basis} in ${windowDays} days; 90% earns full marks and 70% earns under half of them.${selfNote}`,
        detail: `${reviewed} of ${merged} merged PR${
          merged === 1 ? '' : 's'
        } ${basis} in ${windowDays} days`,
      };
    },
  };
}
