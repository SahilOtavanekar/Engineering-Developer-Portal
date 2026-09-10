import { canonicalBand } from '@internal/backstage-plugin-fleet-common';
import type { CSSProperties } from 'react';

/**
 * How a score band is rendered, on every surface that renders one.
 *
 * BUI's intent tokens come in pairs and it matters which is used where:
 *
 * - `--bui-<intent>-bg` is a saturated fill (green / orange / red).
 * - `--bui-<intent>-fg` is the text colour *for use on that fill* -- black or
 *   white, not a colour in its own right.
 * - `--bui-<intent>-fg-subdued` is coloured text readable against the ordinary
 *   page background, and adapts between light and dark themes.
 *
 * Using `-fg` as a standalone text or background colour paints everything
 * black and white, which is exactly what happened before this was written down.
 *
 * **Four bands, three colours, and that is the specification rather than an
 * oversight.** The health classification table marks *both* Excellent (90-100)
 * and Healthy (75-89) with a green circle, amber for Needs Attention and red
 * for At Risk. Excellent and Healthy therefore share the positive intent: the
 * distinction between them is a refinement of good news rather than a different
 * action, and the label on every surface says which one it is. Giving Excellent
 * a fourth hue would mean a new `--portal-*` token pair in both theme modes
 * plus the contrast tests to go with it -- worth doing if the distinction
 * should be visible at a glance, and deliberately not done on the strength of
 * the specification's own colour choice.
 *
 * **The maps below are keyed by the current band names only.** `critical`, the
 * name At Risk was stored under before the fourth band landed, is resolved by
 * `canonicalBand` in `fleet-common` -- so nothing here has to know about it and
 * the legacy name is recorded in exactly one place. Every accessor in this file
 * canonicalises, which is why no component should index these maps directly.
 */
const BAND_LABEL: Record<string, string> = {
  excellent: 'Excellent',
  healthy: 'Healthy',
  'needs-attention': 'Needs attention',
  'at-risk': 'At risk',
};

/**
 * How bad a band is, for ordering.
 *
 * Sorting the labels alphabetically yields at-risk, excellent, healthy,
 * needs-attention, which is not an ordering of anything -- so the Status column
 * needs a rank rather than its text. Worst is highest, so that a descending
 * sort puts the repositories needing attention on top and the column behaves
 * like every other measure on the table.
 *
 * A band absent from this map has no known severity and is treated as missing
 * rather than as healthy, which is the same rule the rest of the table follows
 * for data it does not have. Every map here is keyed the same loose way, and
 * for the same reason: the band arrives as a string from a scoring pass whose
 * thresholds are configuration.
 */
const BAND_SEVERITY: Record<string, number> = {
  excellent: 0,
  healthy: 1,
  'needs-attention': 2,
  'at-risk': 3,
};

/** Coloured text on the page background. */
const BAND_TEXT: Record<string, string> = {
  excellent: 'var(--bui-positive-fg-subdued)',
  healthy: 'var(--bui-positive-fg-subdued)',
  'needs-attention': 'var(--bui-warning-fg-subdued)',
  'at-risk': 'var(--bui-negative-fg-subdued)',
};

/**
 * A quiet tint, with coloured text on it.
 *
 * Was the saturated `-bg` fill with `-fg` on top. Three fully saturated blocks
 * across the width of the page pulled the eye before anything else on it,
 * including the problems the bar exists to lead you to -- and the bar is
 * context, not the headline. `-bg-subdued` is the same hue at low saturation,
 * so a band still reads as green, amber or red at a glance without competing
 * with the content.
 *
 * `-bg-subdued` is a BUI token, but the portal theme has to declare it: the
 * theme overrides only `bg`, `fg`, `fg-subdued` and `border`, so without a
 * declaration this fell through to BUI's own palette and picked up a different
 * hue family. See `StatusTokens.bgSubdued`, and the contrast test covers this
 * text-on-fill pair in both themes.
 */
const BAND_FILL: Record<string, CSSProperties> = {
  excellent: {
    background: 'var(--bui-positive-bg-subdued)',
    color: 'var(--bui-positive-fg-subdued)',
  },
  healthy: {
    background: 'var(--bui-positive-bg-subdued)',
    color: 'var(--bui-positive-fg-subdued)',
  },
  'needs-attention': {
    background: 'var(--bui-warning-bg-subdued)',
    color: 'var(--bui-warning-fg-subdued)',
  },
  'at-risk': {
    background: 'var(--bui-negative-bg-subdued)',
    color: 'var(--bui-negative-fg-subdued)',
  },
};

/** Every band this portal renders, best first. */
export const BANDS = Object.keys(BAND_LABEL);

/** Falls back to inheriting rather than guessing at an unrecognised band. */
export function bandText(band: string | undefined): string | undefined {
  const canonical = canonicalBand(band);
  return canonical ? BAND_TEXT[canonical] : undefined;
}

/**
 * The quiet tint for a band pill.
 *
 * Undefined rather than a guessed colour for an unrecognised band: the pill
 * then renders unfilled with its label intact, which is legible, where a
 * fabricated intent would state a severity the portal does not know.
 */
export function bandFill(band: string | undefined): CSSProperties | undefined {
  const canonical = canonicalBand(band);
  return canonical ? BAND_FILL[canonical] : undefined;
}

/**
 * How bad a band is, or undefined when the name is not recognised.
 *
 * Undefined so the table's comparator sorts it as missing data rather than as
 * the healthiest thing on the estate, which ranking it 0 would do.
 */
export function bandSeverity(band: string | undefined): number | undefined {
  const canonical = canonicalBand(band);
  return canonical ? BAND_SEVERITY[canonical] : undefined;
}

export function bandLabel(band: string): string {
  const canonical = canonicalBand(band) ?? band;
  return BAND_LABEL[canonical] ?? band;
}
