/**
 * Band vocabulary, shared by the backend and the frontend.
 *
 * The presentation of a band -- its label, colour and sort rank -- lives in
 * `plugins/fleet/src/bands.ts`, which is a frontend concern. What lives here is
 * what both sides have to agree on: which names are current, which are historic,
 * and which of them count as good news. Four places would otherwise each decide
 * for themselves -- the overview endpoint's counts, the fleet page's counts, its
 * band filter and the problems banner -- and three of them already had.
 */

/**
 * Band names written by earlier scoring passes, mapped to what they are called
 * now.
 *
 * `critical` became `at-risk` when the fourth band landed and the thresholds
 * were specified. Score history is append-only, so rows written before then
 * keep the old name for ever and the aliases cannot simply be dropped once the
 * estate is re-scored -- the *latest* row per repository is rewritten by the
 * next pass, but the history behind it is not.
 */
const BAND_ALIASES: Record<string, string> = {
  critical: 'at-risk',
};

/**
 * The current name for a band.
 *
 * Apply this before comparing two bands or counting them. The fleet page's band
 * filter is an equality test against the value a segment was built from, so
 * without it clicking "At risk (42)" could return fewer rows than the segment
 * claimed -- which reads as a broken filter rather than as a renamed band.
 *
 * An unrecognised band is returned as it is, not defaulted: the thresholds are
 * configuration, so a name this code has never seen is possible and must
 * survive to be rendered as itself.
 */
export function canonicalBand(band: string | undefined): string | undefined {
  if (band === undefined) return undefined;
  return BAND_ALIASES[band] ?? band;
}

/**
 * Bands good enough that their repository needs no prompting.
 *
 * Listed positively rather than tested as `band !== 'healthy'`, which is what
 * both callers did before the fourth band landed: with Excellent above Healthy,
 * that test treated the *best* repositories on the estate as failing ones.
 */
const SATISFACTORY_BANDS = new Set(['excellent', 'healthy']);

/**
 * Whether a band is good enough that its repository needs no prompting.
 *
 * An unrecognised band is **not** assumed satisfactory. Thresholds are
 * configuration, so an unknown name is possible, and treating it as good news
 * would silently stop reporting problems for whatever it is.
 */
export function isSatisfactoryBand(band: string | undefined): boolean {
  const canonical = canonicalBand(band);
  return canonical !== undefined && SATISFACTORY_BANDS.has(canonical);
}
