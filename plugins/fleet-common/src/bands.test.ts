import { canonicalBand, isSatisfactoryBand } from './bands';

describe('canonicalBand', () => {
  it('leaves a current band name alone', () => {
    for (const band of ['excellent', 'healthy', 'needs-attention', 'at-risk']) {
      expect(canonicalBand(band)).toBe(band);
    }
  });

  /**
   * The whole reason this function exists. Score history is append-only, so
   * rows written while At Risk was called `critical` keep that name for ever,
   * and the latest row per repository still holds it until the next scoring
   * pass. Comparing raw strings made the fleet page's "At risk (42)" segment
   * filter to nothing.
   */
  it('resolves the pre-rename name for At Risk', () => {
    expect(canonicalBand('critical')).toBe('at-risk');
  });

  it('passes an unrecognised band through rather than defaulting it', () => {
    // Thresholds are configuration, so a band this code has never seen is
    // possible and must survive to be rendered as itself.
    expect(canonicalBand('made-up')).toBe('made-up');
  });

  it('has nothing to say about an absent band', () => {
    expect(canonicalBand(undefined)).toBeUndefined();
  });
});

describe('isSatisfactoryBand', () => {
  it('accepts both bands the specification marks green', () => {
    expect(isSatisfactoryBand('excellent')).toBe(true);
    expect(isSatisfactoryBand('healthy')).toBe(true);
  });

  it('rejects the bands that need work', () => {
    expect(isSatisfactoryBand('needs-attention')).toBe(false);
    expect(isSatisfactoryBand('at-risk')).toBe(false);
  });

  it('rejects the pre-rename name for At Risk', () => {
    expect(isSatisfactoryBand('critical')).toBe(false);
  });

  /**
   * Not assumed good. Treating an unknown band as satisfactory would silently
   * stop reporting problems for whatever it turned out to be -- and since the
   * thresholds are configuration, a name nothing here recognises is possible.
   */
  it('does not assume an unrecognised band is good news', () => {
    expect(isSatisfactoryBand('made-up')).toBe(false);
  });

  it('treats an unscored repository as unsatisfactory', () => {
    expect(isSatisfactoryBand(undefined)).toBe(false);
  });
});
