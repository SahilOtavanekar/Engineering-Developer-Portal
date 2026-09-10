import type { Scorer } from '../types';

export interface PullRequestSizeOptions {
  /**
   * Which statistic the bands are applied to.
   *
   * Defaults to **`mean`**, which is what the specification's table names
   * ("Average PR Size"), so the shipped behaviour follows the document.
   *
   * **The evidence for `median` is strong and it is a product decision, not a
   * technical one** -- which is why this is config rather than a constant, the
   * same reasoning as `codeReviewCompleted.countSelfApprovals`. Measured
   * 2026-09-10 across the 44 repositories with merged pull requests in the
   * window:
   *
   * | statistic | 10 pts | 3 pts | 1 pt | mean points |
   * | --------- | -----: | ----: | ---: | ----------: |
   * | mean      |     13 |     6 |   25 |        3.93 |
   * | median    |     24 |     7 |   13 |        6.23 |
   *
   * The 25 scoring 1 of 10 on the mean are overwhelmingly scored on release
   * mechanics rather than review burden: `oxp-backend` merged **66** pull
   * requests typically **240** lines long -- the busiest and among the most
   * disciplined repositories on the estate -- and scores 1 of 10 because one
   * promotion moved 35,028 lines. `daarwyn-data-sync-jobs` is 12 pull requests
   * with a median of **3**. `ingest-jobs` is 3 with a median of **76** and a
   * mean of 192,474.
   *
   * Excluding imports was measured as a third option and rejected: it leaves 7
   * repositories unmeasurable, and it does not help `portal-ui`, `crm` or
   * `daarwyn-ui`, whose large pull requests are not mostly-added files.
   */
  statistic?: 'mean' | 'median';
}

/**
 * The specification's bands, as fractions of this metric's weight.
 *
 * **Note the bottom band is 1, not 0** -- the only metric on the scorecard that
 * never pays nothing. A team merging 5,000-line pull requests is doing
 * something, which is more than a repository with no pull requests at all can
 * say, and the specification's table reflects that.
 *
 * Each entry states the points it is worth at the nominal weight of 10.
 */
const BANDS: Array<{ upTo: number; fraction: number }> = [
  { upTo: 399, fraction: 10 / 10 },
  { upTo: 1000, fraction: 3 / 10 },
];

const OVER_LIMIT_FRACTION = 1 / 10;

function bandFraction(averageChangedLines: number): number {
  return (
    BANDS.find(band => averageChangedLines <= band.upTo)?.fraction ??
    OVER_LIMIT_FRACTION
  );
}

/**
 * Are pull requests small enough to review properly?
 *
 * Scored by default on the **mean** changed lines across merged pull requests
 * in the window, because that is the statistic the specification's table names
 * -- see {@link PullRequestSizeOptions} for the measured case for the median
 * and how to switch. Generated and vendored files are excluded before counting;
 * the requirement suggests it, though on this estate it recovers only 15,681
 * lines of 2.2 million.
 *
 * **What actually inflates the mean is branch promotion.** `portal-apis#73`
 * moved 601,858 lines across 3,304 files, 3,301 of them newly added -- a
 * long-lived `stage` branch landing on `main`, which is release mechanics
 * rather than a change anybody reviewed. One of those in the window drags a
 * mean past 1,000 however disciplined every later change was.
 *
 * So the detail line reports the other statistic beside the scored one
 * whenever they disagree by more than a factor of two, and names the imports
 * when there are any. Whichever is scored, the evidence beside it is what stops
 * the number being read as a verdict on the team.
 *
 * Unmeasurable in two cases, and they are different: no merged pull requests in
 * the window at all, and merged pull requests whose diffstat has not been
 * fetched yet. The second is the portal's own gap -- one request per pull
 * request, about 389 for a first sweep -- and a repository must not be scored
 * as small merely because nothing has looked.
 */
export function pullRequestSizeScorer(
  options: PullRequestSizeOptions = {},
): Scorer {
  const statistic = options.statistic ?? 'mean';

  return {
    id: 'pull-request-size',
    title: 'Pull request size',
    score({ size, windowDays }) {
      if (!size || size.measured === 0) return null;

      const {
        measured,
        pending,
        averageChangedLines,
        medianChangedLines,
        largestChangedLines,
        imports,
      } = size;
      if (averageChangedLines === undefined) return null;

      // The scored figure, and the word for it. `median` falls back to the mean
      // rather than refusing to score: `medianChangedLines` is undefined only
      // when nothing was measured, which the guard above has already rejected,
      // so this is belt and braces rather than a real path.
      const scored =
        statistic === 'median'
          ? medianChangedLines ?? averageChangedLines
          : averageChangedLines;
      const scoredWord = statistic === 'median' ? 'typically' : 'on average';

      // The other statistic, shown whenever the two disagree by more than a
      // factor of two -- which on this estate is where the whole argument
      // lives. `daarwyn-data-sync-jobs` reads 2730 on average and 3 typically.
      // Naming them in words rather than as "mean" and "median" keeps the line
      // readable without pretending they are the same thing.
      const other =
        statistic === 'median' ? averageChangedLines : medianChangedLines;
      const otherWord = statistic === 'median' ? 'on average' : 'typically';
      const contrast =
        other !== undefined &&
        Math.min(scored, other) * 2 < Math.max(scored, other)
          ? `, ${otherWord} ${other}`
          : '';

      // A pull request still awaiting its diffstat is not counted, and saying
      // so stops the figure reading as final when a sweep is mid-flight.
      const partial = pending > 0 ? ` (${pending} not yet measured)` : '';

      const importNote =
        imports > 0
          ? ` ${imports} of them ${
              imports === 1 ? 'is' : 'are'
            } an import of mostly new files, which no review could have made smaller.`
          : '';

      return {
        fraction: bandFraction(scored),
        detail:
          `${scored} changed lines ${scoredWord} across ${measured} ` +
          `merged PR${measured === 1 ? '' : 's'} in ${windowDays} days` +
          `${contrast}${partial}`,
        remediation:
          scored < 400
            ? undefined
            : `Split work into smaller pull requests: under 400 changed lines earns full marks, 400-1,000 earns three tenths. The largest here moved ${
                largestChangedLines ?? scored
              } lines.${importNote} Generated and vendored files are already excluded.`,
      };
    },
  };
}
