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
 * Explicit widths, because material-table's equal split is not one.
 *
 * It writes `width: calc(33.3333% + 0px)` inline onto every cell, and under
 * `tableLayout: 'fixed'` the browser honours it -- measured on the MDLH
 * project: Name 324px, Owner 324px and **Description 7px**, which is not a
 * narrow column, it is an invisible one. The theme's `width: auto !important`
 * reset for `BackstageTable` does not reach this table.
 *
 * A name is the thing being scanned for and the longest value here
 * (`dataAgentUi-contact-company-backend`); an owner is two words; a
 * description is worth whatever is left. Percentages total 100.
 */
const columns = [
  {
    ...EntityTable.columns.createEntityRefColumn<ComponentEntity>({
      defaultKind: 'component',
    }),
    width: '38%',
  },
  { ...EntityTable.columns.createOwnerColumn<ComponentEntity>(), width: '24%' },
  {
    ...EntityTable.columns.createMetadataDescriptionColumn<ComponentEntity>(),
    width: '38%',
  },
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
      columns={columns}
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
