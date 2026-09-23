import {
  RELATION_HAS_PART,
  type ComponentEntity,
} from '@backstage/catalog-model';
import { Progress, ResponseErrorPanel } from '@backstage/core-components';
import {
  EntityTable,
  useEntity,
  useRelatedEntities,
} from '@backstage/plugin-catalog-react';
import { EntityCardBlueprint } from '@backstage/plugin-catalog-react/alpha';

/**
 * The repositories in a Project, without the Lifecycle column.
 *
 * **Why this is composed rather than configured.** The stock card does accept
 * a column list -- both a legacy `columns` prop and a newer `columnConfig` --
 * but `HasComponentsCard` is **not exported** from `@backstage/plugin-catalog`
 * or its alpha entry point: only `HasComponentsCardProps` is, and the stock
 * extension reaches the component through a deep dynamic import. So there is
 * nothing to pass props to.
 *
 * `EntityTable` and `useRelatedEntities` are public, and are what the stock
 * card is itself built from, so this is a thin recomposition rather than a
 * reimplementation. The alternative was positional CSS to hide the fourth
 * column, which is the trap the catalog table's old column hiding was -- a
 * rule that silently hides the wrong thing the moment upstream reorders.
 *
 * **What is dropped.** Lifecycle, which the product owner asked to be rid of
 * and which is `unknown` across most of this estate, and Type with it for the
 * same reason -- `service` or `unknown` almost everywhere. Name, Owner and
 * Description remain: on a project's page the question is which repositories
 * it holds, who answers for each, and what they do.
 *
 * **The `spec.lifecycle` field is untouched, and has to be.** It is required by
 * the Component v1alpha1 schema alongside `type` and `owner`, so an entity
 * without it fails validation and is never ingested. This removes the column,
 * not the data.
 *
 * The cost of composing is the stock card's empty-state help link, which
 * pointed at Backstage's own documentation on the system model -- not useful
 * here, where every component is synthesised from Bitbucket and none is
 * hand-written.
 */
/**
 * Name, Owner and Description.
 *
 * **All three stay. Removing one is a product decision, not a formatting one**,
 * and it was made here twice without being asked for -- once on a wrong
 * diagnosis (a 7px render that turned out to be the theme's unscoped
 * `th:last-child { width: 1% }`) and once on a correct measurement that still
 * did not authorise it.
 *
 * The measurement is worth keeping, because it is the constraint this card
 * lives with. On MDLH, the largest project at 37 rows, in the ~654px column the
 * entity layout allows:
 *
 * | column      | content needs | filled in   |
 * | ----------- | ------------- | ----------- |
 * | Name        | 276px         | 37 of 37    |
 * | Owner       | 182px         | 37 of 37    |
 * | Description | 368px         | 1 of 37     |
 *
 * Three columns share 654px equally, so Name gets 218px against the 276 it
 * wants. **An earlier version of this note said the longest names "truncate".
 * They did not -- they overlapped the Owner column**, because the cells are
 * `nowrap` with `overflow: visible`, and nothing was measured to check. They
 * wrap now; see `WRAPPING_CELL`.
 *
 * That squeeze is a real cost of keeping Description, not an argument for
 * dropping it -- the fix, if one is wanted, is to size the columns rather than
 * to remove one, which needs the theme's `BackstageTable` reset
 * (`width: auto !important`) scoped away from this table first. It beats any
 * `width` set here, so a `TableColumn.width` would be dead code today.
 */
/**
 * Let a cell that cannot fit **wrap**, rather than paint over its neighbour.
 *
 * Backstage's table gives every cell `white-space: nowrap` with
 * `overflow: visible` and `text-overflow: clip`. Under `tableLayout: 'fixed'`
 * that is the worst of the three options: content too wide to fit can neither
 * wrap nor be clipped, so it is drawn straight across the next column.
 * Measured on MDLH before this: 1 row overlapping by 3px at a 1600px viewport,
 * 7 by 74px at 1280, and **18 of 38 by up to 131px at 1024**. An earlier
 * comment here claimed the long names "truncate" -- they never did.
 *
 * `anywhere` rather than `break-word` because these are single unbroken
 * tokens: `Data_Plugin_Lookup_Index_Sync_Function` has no space to break at,
 * and `break-word` will not split inside a word that has never had a chance
 * to sit on its own line.
 */
const WRAPPING_CELL = {
  whiteSpace: 'normal' as const,
  overflowWrap: 'anywhere' as const,
};

/**
 * Truncate prose instead of wrapping it.
 *
 * A description is supplementary -- 1 of 37 repositories on MDLH has one -- so
 * a row grown to three lines to show it costs every other row's scannability
 * for something nobody came to read. `nowrap` is already set, so it only needs
 * somewhere to clip and a mark to say it did.
 */
const TRUNCATING_CELL = {
  overflow: 'hidden' as const,
  textOverflow: 'ellipsis' as const,
};

/** Merges a cell style onto a generated column without discarding its own. */
function withCellStyle<T extends { cellStyle?: unknown }>(
  column: T,
  style: Record<string, string>,
): T {
  return {
    ...column,
    cellStyle: { ...(column.cellStyle as object | undefined), ...style },
  };
}

/**
 * Exported so a test can reach it.
 *
 * The cell styles here are the whole of the overlap fix and are invisible to
 * every other check -- `yarn tsc` cannot see a missing style, and the defect
 * only shows on a project page at a narrow enough width. Regenerating this
 * array from `EntityTable.columns` without re-applying them is the obvious way
 * to lose it.
 */
export const projectRepositoryColumns = [
  // The name is the identifier and these names differ at the END --
  // `dataAgentUi-contact-company-backend` against
  // `dataAgentUi-emailpattern-backend` -- so truncating it is the one option
  // that could make two rows read identically. It wraps.
  withCellStyle(
    EntityTable.columns.createEntityRefColumn<ComponentEntity>({
      defaultKind: 'component',
    }),
    WRAPPING_CELL,
  ),
  // Person names break at spaces, so ordinary wrapping is enough.
  withCellStyle(EntityTable.columns.createOwnerColumn<ComponentEntity>(), {
    whiteSpace: 'normal',
  }),
  withCellStyle(
    EntityTable.columns.createMetadataDescriptionColumn<ComponentEntity>(),
    TRUNCATING_CELL,
  ),
];

function ProjectComponentsCard() {
  const { entity } = useEntity();
  const { entities, loading, error } = useRelatedEntities(entity, {
    type: RELATION_HAS_PART,
    kind: 'Component',
  });

  if (loading) return <Progress />;
  if (error) return <ResponseErrorPanel error={error} />;

  return (
    <EntityTable
      title="Repositories"
      entities={(entities ?? []) as ComponentEntity[]}
      columns={projectRepositoryColumns}
      emptyContent="This project has no repositories."
      /**
       * Fixed layout, because the automatic one does not fit this card.
       *
       * Measured on the MDLH project: material-table laid the table out at
       * 937px inside a 654px card -- a 283px overflow -- because the automatic
       * algorithm sizes columns to their content and some descriptions run
       * long. The card scrolls, so nothing was unreachable, but Description sat
       * off the right edge until you found the scrollbar.
       *
       * Fixed layout takes the width from the container instead, so the three
       * columns share what there is and a long description truncates. The
       * entity layout gives this card a ~1fr column beside the About card,
       * which is not enough room to let content decide.
       */
      tableOptions={{ tableLayout: 'fixed' }}
    />
  );
}

export const hasComponentsCard = EntityCardBlueprint.make({
  /**
   * Its own name, NOT the stock `has-components`.
   *
   * Registering under the stock name did not override it -- measured on the
   * MDLH project, both cards rendered and the page carried two tables, the
   * second still showing Lifecycle and Type. Whatever makes that work for
   * `page:catalog` does not apply here. So the stock card is disabled in
   * `app-config.yaml` (safe: nothing resolves a route ref to a card) and this
   * one stands on its own id.
   */
  name: 'project-repositories',
  params: {
    // Kept from the stock definition: without it the card renders on every
    // kind, including the Components that hold no components of their own.
    filter: { kind: 'system' },
    loader: async () => <ProjectComponentsCard />,
  },
});
