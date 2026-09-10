import { BANDS, bandFill, bandLabel, bandSeverity, bandText } from './bands';

/**
 * BUI's `--bui-<intent>-fg` tokens are black or white -- they are the text
 * colour for use *on* the matching `-bg` fill, not colours in their own right.
 * Using one as standalone text or as a background paints the UI black and
 * white, which is precisely what shipped before these tests existed.
 */
describe('band tokens', () => {
  it('covers every band', () => {
    for (const band of BANDS) {
      expect(bandLabel(band)).toBeTruthy();
      expect(bandText(band)).toBeTruthy();
      expect(bandFill(band)).toBeTruthy();
      expect(bandSeverity(band)).toBeDefined();
    }
  });

  it('renders the four documented bands', () => {
    expect(BANDS).toEqual([
      'excellent',
      'healthy',
      'needs-attention',
      'at-risk',
    ]);
  });

  describe('bandText, which is drawn on the page background', () => {
    it('uses subdued foregrounds, which are actually coloured', () => {
      for (const band of BANDS) {
        expect(bandText(band)).toMatch(/^var\(--bui-\w+-fg-subdued\)$/);
      }
    });

    it('never uses a bare intent foreground, which is black or white', () => {
      for (const band of BANDS) {
        expect(bandText(band)).not.toMatch(/--bui-\w+-fg\)/);
      }
    });

    /**
     * Three intents across four bands, because the health classification table
     * marks Excellent and Healthy with the same green circle. Asserted as an
     * explicit pair rather than by relaxing the distinctness check, so a band
     * accidentally picking up a *neighbouring* intent -- needs-attention
     * turning green, say -- still fails here.
     */
    it('gives Excellent and Healthy the same intent, by specification', () => {
      expect(bandText('excellent')).toBe(bandText('healthy'));
      expect(bandFill('excellent')).toEqual(bandFill('healthy'));
    });

    it('gives each severity level a distinct colour', () => {
      const levels = ['healthy', 'needs-attention', 'at-risk'];
      const values = levels.map(band => bandText(band));
      expect(new Set(values).size).toBe(levels.length);
    });
  });

  describe('bandFill, which is a quiet tint', () => {
    it('pairs the subdued background with the subdued foreground', () => {
      // Both halves subdued, not one of each. `-fg` is the text colour for the
      // *saturated* fill -- black or white -- so pairing it with `-bg-subdued`
      // would put white on a pale tint. The portal theme declares
      // `-bg-subdued` itself; see `StatusTokens.bgSubdued`.
      for (const band of BANDS) {
        const fill = bandFill(band)!;
        expect(fill.background).toMatch(/^var\(--bui-(\w+)-bg-subdued\)$/);
        expect(fill.color).toMatch(/^var\(--bui-(\w+)-fg-subdued\)$/);

        // Both halves must name the same intent, or the text is unreadable.
        const intentOf = (value: string) =>
          /--bui-(\w+)-(?:bg|fg)-subdued/.exec(value)?.[1];
        expect(intentOf(String(fill.background))).toBe(
          intentOf(String(fill.color)),
        );
      }
    });

    it('gives each severity level a distinct fill', () => {
      const levels = ['healthy', 'needs-attention', 'at-risk'];
      const values = levels.map(band => bandFill(band)!.background);
      expect(new Set(values).size).toBe(levels.length);
    });
  });

  describe('bandSeverity, which is what the Status column sorts on', () => {
    it('runs worst-highest, so descending leads with the worst', () => {
      expect(bandSeverity('excellent')).toBeLessThan(bandSeverity('healthy')!);
      expect(bandSeverity('healthy')).toBeLessThan(
        bandSeverity('needs-attention')!,
      );
      expect(bandSeverity('needs-attention')).toBeLessThan(
        bandSeverity('at-risk')!,
      );
    });

    /**
     * Missing rather than 0. Thresholds are configuration, so an unrecognised
     * band is possible, and ranking it best would present it as the healthiest
     * thing on the estate.
     */
    it('treats an unrecognised band as missing, not as the best', () => {
      expect(bandSeverity('made-up')).toBeUndefined();
      expect(bandSeverity(undefined)).toBeUndefined();
    });
  });

  /**
   * `critical` is what At Risk was stored as before the fourth band landed.
   * Score history is append-only, so those rows exist for ever and the latest
   * row per repository still holds the old name until the next scoring pass
   * rewrites it. Without this the band rendered as an uncoloured raw string.
   */
  describe('the pre-rename band name', () => {
    it('renders as At Risk', () => {
      expect(bandLabel('critical')).toBe('At risk');
      expect(bandText('critical')).toBe(bandText('at-risk'));
      expect(bandFill('critical')).toEqual(bandFill('at-risk'));
    });

    it('sorts as At Risk rather than as missing data', () => {
      expect(bandSeverity('critical')).toBe(bandSeverity('at-risk'));
    });
  });

  describe('helpers', () => {
    it('resolves a known band', () => {
      expect(bandText('at-risk')).toBe('var(--bui-negative-fg-subdued)');
      expect(bandLabel('needs-attention')).toBe('Needs attention');
    });

    it('inherits rather than guessing for an unknown band', () => {
      expect(bandText(undefined)).toBeUndefined();
      expect(bandText('made-up')).toBeUndefined();
      expect(bandFill('made-up')).toBeUndefined();
    });

    it('falls back to the raw band name when there is no label', () => {
      expect(bandLabel('made-up')).toBe('made-up');
    });
  });
});
