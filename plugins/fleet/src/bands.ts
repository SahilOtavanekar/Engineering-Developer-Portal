/**
 * Score bands, shared by every surface that renders one.
 *
 * Semantic intent tokens, deliberately separate from any accent colour: these
 * carry meaning (good / needs attention / bad) rather than branding, and they
 * adapt to the viewer's theme.
 */
export const BAND_LABEL: Record<string, string> = {
  healthy: 'Healthy',
  'needs-attention': 'Needs attention',
  critical: 'Critical',
};

export const BAND_COLOR: Record<string, string> = {
  healthy: 'var(--bui-positive-fg)',
  'needs-attention': 'var(--bui-warning-fg)',
  critical: 'var(--bui-negative-fg)',
};

/** Falls back to neutral rather than guessing at an unrecognised band. */
export function bandColor(band: string | undefined): string | undefined {
  return band ? BAND_COLOR[band] : undefined;
}

export function bandLabel(band: string): string {
  return BAND_LABEL[band] ?? band;
}
