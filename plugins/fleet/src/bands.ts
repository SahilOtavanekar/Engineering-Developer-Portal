import type { CSSProperties } from 'react';

/**
 * Score bands, shared by every surface that renders one.
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
 */
export const BAND_LABEL: Record<string, string> = {
  healthy: 'Healthy',
  'needs-attention': 'Needs attention',
  critical: 'Critical',
};

/**
 * How bad a band is, for ordering.
 *
 * Sorting the labels alphabetically yields critical, healthy, needs-attention,
 * which is not an ordering of anything -- so the Status column needs a rank
 * rather than its text. Worst is highest, so that a descending sort puts the
 * repositories needing attention on top and the column behaves like every
 * other measure on the table.
 *
 * A band absent from this map has no known severity and is treated as missing
 * rather than as healthy, which is the same rule the rest of the table follows
 * for data it does not have. `BAND_LABEL` is keyed the same loose way, and for
 * the same reason: the band arrives as a string from a scoring pass whose
 * thresholds are configuration.
 */
export const BAND_SEVERITY: Record<string, number> = {
  healthy: 0,
  'needs-attention': 1,
  critical: 2,
};

/** Coloured text on the page background. */
export const BAND_TEXT: Record<string, string> = {
  healthy: 'var(--bui-positive-fg-subdued)',
  'needs-attention': 'var(--bui-warning-fg-subdued)',
  critical: 'var(--bui-negative-fg-subdued)',
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
export const BAND_FILL: Record<string, CSSProperties> = {
  healthy: {
    background: 'var(--bui-positive-bg-subdued)',
    color: 'var(--bui-positive-fg-subdued)',
  },
  'needs-attention': {
    background: 'var(--bui-warning-bg-subdued)',
    color: 'var(--bui-warning-fg-subdued)',
  },
  critical: {
    background: 'var(--bui-negative-bg-subdued)',
    color: 'var(--bui-negative-fg-subdued)',
  },
};

/** Falls back to inheriting rather than guessing at an unrecognised band. */
export function bandText(band: string | undefined): string | undefined {
  return band ? BAND_TEXT[band] : undefined;
}

export function bandLabel(band: string): string {
  return BAND_LABEL[band] ?? band;
}
