import { catalogReactMessages } from './catalogReact';

describe('catalog-react string overrides', () => {
  it('targets the catalog-react translation ref', () => {
    expect(catalogReactMessages.id).toBe('catalog-react');
  });

  it('is a partial override, so unlisted strings keep the plugin wording', () => {
    // A full override would have to restate every message in the ref, and any
    // message the plugin adds later would render blank.
    expect(catalogReactMessages.full).toBeFalsy();
  });

  it('renames the System column to Project', () => {
    // Backstage's `System` is filled from `project_key`, so every value in the
    // column is a Bitbucket project key. The header is computed inside
    // `EntityTableColumnTitle` and is not reachable through the table's
    // `columns` prop or any CSS -- this ref is the only supported route to it,
    // so an upstream rename of the key must fail the build, not the column.
    // `Object.keys(...).toContain` rather than `toHaveProperty`: these keys
    // contain literal dots, and `toHaveProperty` reads a dot as a nested path.
    expect(Object.keys(catalogReactMessages.messages)).toContain(
      'entityTableColumnTitle.system',
    );
    expect(catalogReactMessages.messages['entityTableColumnTitle.system']).toBe(
      'Project',
    );
  });

  it('leaves no override still naming Backstage', () => {
    const offenders = Object.entries(catalogReactMessages.messages)
      .filter(([, value]) => /backstage/i.test(String(value)))
      .map(([key]) => key);

    expect(offenders).toEqual([]);
  });
});
