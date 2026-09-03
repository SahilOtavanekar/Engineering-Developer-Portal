import { catalogMessages } from './catalog';

describe('catalog string overrides', () => {
  it('targets the catalog translation ref', () => {
    expect(catalogMessages.id).toBe('catalog');
  });

  it('is a partial override, so unlisted strings keep the plugin wording', () => {
    // A full override would have to restate every message in the ref, and any
    // message the plugin adds later would render blank.
    expect(catalogMessages.full).toBeFalsy();
  });

  it('blanks the index page heading', () => {
    // The whole reason the override exists: `indexPage.title` defaults to
    // `{{orgName}} Catalog`, which rendered "Demand AI Catalog" directly under
    // a breadcrumb already reading "Catalog". Empty string, not absent -- an
    // absent key falls through to the plugin default and the heading returns.
    // `Object.keys(...).toContain` rather than `toHaveProperty`: the key
    // contains a literal dot, and `toHaveProperty` reads a dot as a nested
    // path.
    expect(Object.keys(catalogMessages.messages)).toContain('indexPage.title');
    expect(catalogMessages.messages['indexPage.title']).toBe('');
  });

  it('leaves no override still naming Backstage', () => {
    const offenders = Object.entries(catalogMessages.messages)
      .filter(([, value]) => /backstage/i.test(String(value)))
      .map(([key]) => key);

    expect(offenders).toEqual([]);
  });
});
