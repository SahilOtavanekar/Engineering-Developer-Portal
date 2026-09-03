import { BAND_FILL, BAND_LABEL, BAND_TEXT, bandLabel, bandText } from './bands';

const BANDS = ['healthy', 'needs-attention', 'critical'];

/**
 * BUI's `--bui-<intent>-fg` tokens are black or white -- they are the text
 * colour for use *on* the matching `-bg` fill, not colours in their own right.
 * Using one as standalone text or as a background paints the UI black and
 * white, which is precisely what shipped before these tests existed.
 */
describe('band tokens', () => {
  it('covers every band', () => {
    for (const band of BANDS) {
      expect(BAND_LABEL[band]).toBeTruthy();
      expect(BAND_TEXT[band]).toBeTruthy();
      expect(BAND_FILL[band]).toBeTruthy();
    }
  });

  describe('BAND_TEXT, which is drawn on the page background', () => {
    it('uses subdued foregrounds, which are actually coloured', () => {
      for (const band of BANDS) {
        expect(BAND_TEXT[band]).toMatch(/^var\(--bui-\w+-fg-subdued\)$/);
      }
    });

    it('never uses a bare intent foreground, which is black or white', () => {
      for (const band of BANDS) {
        expect(BAND_TEXT[band]).not.toMatch(/--bui-\w+-fg\)/);
      }
    });

    it('gives each band a distinct colour', () => {
      const values = BANDS.map(band => BAND_TEXT[band]);
      expect(new Set(values).size).toBe(BANDS.length);
    });
  });

  describe('BAND_FILL, which is a quiet tint', () => {
    it('pairs the subdued background with the subdued foreground', () => {
      // Both halves subdued, not one of each. `-fg` is the text colour for the
      // *saturated* fill -- black or white -- so pairing it with `-bg-subdued`
      // would put white on a pale tint. The portal theme declares
      // `-bg-subdued` itself; see `StatusTokens.bgSubdued`.
      for (const band of BANDS) {
        const fill = BAND_FILL[band];
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

    it('gives each band a distinct fill', () => {
      const values = BANDS.map(band => BAND_FILL[band].background);
      expect(new Set(values).size).toBe(BANDS.length);
    });
  });

  describe('helpers', () => {
    it('resolves a known band', () => {
      expect(bandText('critical')).toBe(BAND_TEXT.critical);
      expect(bandLabel('needs-attention')).toBe('Needs attention');
    });

    it('inherits rather than guessing for an unknown band', () => {
      expect(bandText(undefined)).toBeUndefined();
      expect(bandText('made-up')).toBeUndefined();
    });

    it('falls back to the raw band name when there is no label', () => {
      expect(bandLabel('made-up')).toBe('made-up');
    });
  });
});
