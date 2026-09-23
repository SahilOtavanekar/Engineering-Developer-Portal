import { projectRepositoryColumns } from './hasComponentsCard';

/**
 * The Repositories card on a project page.
 *
 * Everything asserted here is invisible to the other checks: `yarn tsc` cannot
 * see a missing cell style, and the defect these pin only appears on a project
 * page at a narrow enough viewport.
 *
 * Columns are identified by their **translation key**, not their title:
 * `EntityTable.columns` builds each title as an `<EntityTableColumnTitle
 * translationKey="name" />` element rather than a string, so matching on text
 * silently finds nothing.
 */
describe('the project Repositories table', () => {
  const keyOf = (column: { title?: unknown }) =>
    (column.title as { props?: { translationKey?: string } } | undefined)?.props
      ?.translationKey;

  const byKey = (key: string) =>
    projectRepositoryColumns.find(column => keyOf(column) === key);

  /**
   * Lifecycle and Type are deliberately absent -- a product decision, not a
   * formatting one, and one that has been reversed by accident here before.
   */
  it('shows Name, Owner and Description, and nothing else', () => {
    expect(projectRepositoryColumns.map(keyOf)).toEqual([
      'name',
      'owner',
      'description',
    ]);
  });

  /**
   * The bug this fixes: Backstage's table gives every cell `nowrap` with
   * `overflow: visible`, so under `tableLayout: 'fixed'` a long name could
   * neither wrap nor clip and was painted straight over the Owner column.
   * Measured on MDLH before the fix: 18 of 38 rows overlapping by up to 131px
   * at a 1024px viewport, and 1 by 3px even at 1600px.
   */
  it('lets a long repository name wrap instead of overlapping Owner', () => {
    expect(byKey('name')?.cellStyle).toMatchObject({
      whiteSpace: 'normal',
      // `anywhere`, not `break-word`: these names are single unbroken tokens
      // like `Data_Plugin_Lookup_Index_Sync_Function` with nowhere to break.
      overflowWrap: 'anywhere',
    });
  });

  /**
   * Truncating the name is the one option that could make two rows read
   * identically -- `dataAgentUi-contact-company-backend` and
   * `dataAgentUi-emailpattern-backend` differ only after the prefix.
   */
  it('never truncates the name, which is the identifier', () => {
    expect(byKey('name')?.cellStyle).not.toMatchObject({
      textOverflow: 'ellipsis',
    });
  });

  it('wraps an owner name, which breaks at spaces', () => {
    expect(byKey('owner')?.cellStyle).toMatchObject({
      whiteSpace: 'normal',
    });
  });

  /**
   * Prose is supplementary here -- 1 of 37 repositories on MDLH has a
   * description -- so a row grown to three lines to show one costs every other
   * row's scannability for something nobody came to read.
   */
  it('truncates the description rather than growing the row', () => {
    expect(byKey('description')?.cellStyle).toMatchObject({
      overflow: 'hidden',
      textOverflow: 'ellipsis',
    });
  });
});
