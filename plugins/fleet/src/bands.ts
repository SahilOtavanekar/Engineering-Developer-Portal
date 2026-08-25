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

/** Coloured text on the page background. */
export const BAND_TEXT: Record<string, string> = {
  healthy: 'var(--bui-positive-fg-subdued)',
  'needs-attention': 'var(--bui-warning-fg-subdued)',
  critical: 'var(--bui-negative-fg-subdued)',
};

/** Solid fill, with the text colour that is legible on it. */
export const BAND_FILL: Record<string, CSSProperties> = {
  healthy: {
    background: 'var(--bui-positive-bg)',
    color: 'var(--bui-positive-fg)',
  },
  'needs-attention': {
    background: 'var(--bui-warning-bg)',
    color: 'var(--bui-warning-fg)',
  },
  critical: {
    background: 'var(--bui-negative-bg)',
    color: 'var(--bui-negative-fg)',
  },
};

/** Falls back to inheriting rather than guessing at an unrecognised band. */
export function bandText(band: string | undefined): string | undefined {
  return band ? BAND_TEXT[band] : undefined;
}

export function bandLabel(band: string): string {
  return BAND_LABEL[band] ?? band;
}
