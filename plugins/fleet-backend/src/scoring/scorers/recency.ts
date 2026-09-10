/**
 * One rung of a recency ladder: activity no older than `withinDays` earns
 * `points`.
 *
 * `points` are the specification's own figures rather than a fraction, because
 * that is how its tables are written and a rung is much easier to check against
 * the document this way. {@link recencyLadder} converts them.
 */
export interface RecencyBand {
  withinDays: number;
  points: number;
}

export interface Recency {
  /** Share of the metric's weight earned, 0..1. */
  fraction: number;
  /**
   * Whole days since the activity, or undefined when there has never been any.
   *
   * Floored rather than rounded: something that happened 47.9 days ago is "47
   * days ago" to a reader, and rounding it to 48 would also cross a band
   * boundary at 60.5 days that the scoring itself does not.
   */
  ageDays?: number;
}

/**
 * Grades an instant against a ladder of day thresholds.
 *
 * Shared because the two recency metrics -- whether main is up to date, and
 * whether the repository is being developed at all -- use the **same 30 / 60 /
 * 90 day boundaries with different point values**, so the day arithmetic and
 * the "never" case are common while the reward is not. Rule 1 pays 20/7/3/0 and
 * rule 6 pays 10/7/3/0, which are different shapes: the second is markedly more
 * forgiving of a repository that has slowed down than the first.
 *
 * The fraction is each rung's points over the **top rung's**, so the ladder
 * describes itself and the caller does not have to restate the metric's nominal
 * weight. That is also what keeps the proportions intact if somebody reweights
 * the metric, since the engine multiplies a fraction by the configured weight.
 *
 * Bands must be supplied in ascending `withinDays` order; the first match wins.
 */
export function recencyLadder(
  lastActivity: Date | null | undefined,
  now: Date,
  bands: RecencyBand[],
): Recency {
  const full = bands[0]?.points ?? 0;

  // Never any activity is a real zero, not an absence of data: the bottom rung
  // of every one of these ladders is "no commit for more than 90 days", and a
  // repository that has never had one satisfies that. Whether it is a scaffold
  // or an abandoned service is decided downstream by lifetime commit counts --
  // see `deriveProblems` -- because the two need different things said to them
  // and a scorer cannot tell them apart.
  if (!lastActivity) return { fraction: 0 };

  const ageDays = Math.floor(
    (now.getTime() - new Date(lastActivity).getTime()) / 86_400_000,
  );

  // A timestamp in the future is treated as current rather than rejected.
  // Committer dates are supplied by whoever made the commit and a skewed clock
  // is not the repository's fault; the alternative -- a negative age falling
  // through every rung to zero -- would report an actively developed repository
  // as abandoned.
  // Older than every rung earns nothing. **Not** the last rung's points: an
  // earlier version fell back to those, which silently paid every repository
  // whose main branch had been quiet for years the same 3 of 20 as one quiet
  // for 90 days. On this estate that was 44 repositories scoring the bottom
  // band's points instead of zero, and only a test at 91 days found it.
  const points = bands.find(band => ageDays <= band.withinDays)?.points ?? 0;

  return {
    fraction: full === 0 ? 0 : points / full,
    ageDays: Math.max(0, ageDays),
  };
}

/** `47 days ago`, `today`, singularised. Shared by both recency scorers. */
export function describeAge(ageDays: number): string {
  if (ageDays === 0) return 'today';
  return `${ageDays} day${ageDays === 1 ? '' : 's'} ago`;
}
