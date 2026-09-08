import {
  coreExtensionData,
  createExtensionInput,
  createFrontendModule,
  PageBlueprint,
} from '@backstage/frontend-plugin-api';
import catalogPlugin, {
  CatalogIndexPage,
} from '@backstage/plugin-catalog/alpha';
import { CatalogTable } from '@backstage/plugin-catalog';
import {
  EntityKindPicker,
  UserListPicker,
} from '@backstage/plugin-catalog-react';
import { EntityProjectPicker } from './EntityProjectPicker';
import { hasComponentsCard } from './hasComponentsCard';
import CategoryIcon from '@material-ui/icons/Category';

/**
 * Replaces the catalog index page so its table can be given options.
 *
 * **Why this exists.** `CatalogIndexPage` accepts a `tableOptions` prop that is
 * passed straight through to material-table, and that is the only route to
 * numbered pagination -- `paginationType: 'stepped'` swaps material-table's
 * prev/next arrows for `MTableSteppedPagination`, which renders page buttons
 * and the "1-20 of 96" count beside them. The stock `page:catalog` extension
 * exposes exactly two config keys, `pagination` and `exportSettings`, and
 * neither reaches `tableOptions`. Nothing else does either: there is no
 * swappable component for the table or its pagination anywhere in
 * `core-components` or `plugin-catalog`.
 *
 * **This corrects a note in CLAUDE.md that said replacing this page was not
 * possible** because its route ref "is exported by nothing" and `EntityLayout`,
 * `EntityOrphanWarning` and `plugin-org`'s ownership grid all resolve it, so
 * `useRouteRef` would throw on every entity page. The premise was wrong: the
 * plugin declares `routes: { catalogIndex: rootRouteRef }`, so the ref is
 * reachable as `catalogPlugin.routes.catalogIndex` and is reused below. Every
 * consumer resolves the same ref it always did.
 *
 * **What this costs, and it is the real trade-off.** The wiring below is a copy
 * of the stock factory, so improvements Backstage makes to `page:catalog` stop
 * arriving -- check this file on a `plugin-catalog` upgrade. It is kept as thin
 * as possible to limit that: the export-config merging the original does is
 * omitted, because `exportSettings` is not enabled in this portal's config and
 * the original renders nothing for it either.
 *
 * Deleting this module restores the stock page exactly.
 */
const catalogPage = PageBlueprint.makeWithOverrides({
  // No `name`, so the id is `page:catalog` -- the same id the stock extension
  // registers under, which is what makes this an override rather than a second
  // catalog page.
  //
  // `makeWithOverrides` rather than `make`, because only the override form
  // gives the factory access to `inputs`, and the filter column depends on it.
  inputs: {
    // Load-bearing. `catalog-filter:catalog/kind`, `.../type`, `.../owner` and
    // the rest attach to this input. Omitting it does not fail loudly; it
    // silently renders the page with no filter column at all.
    filters: createExtensionInput([coreExtensionData.reactElement]),
  },
  factory(originalFactory, { inputs }) {
    return originalFactory({
      // `app-config.yaml` overrides this to `/`; `PageBlueprint` resolves
      // `config.path ?? params.path`, so the stock default belongs here.
      path: '/catalog',
      routeRef: catalogPlugin.routes.catalogIndex,
      title: 'Catalog',
      icon: <CategoryIcon fontSize="inherit" />,
      loader: async () => (
        <CatalogIndexPage
          filters={
            <>
              {/**
               * Two filters mounted but not rendered, and they are the whole
               * reason this page shows any rows at all.
               *
               * **`initialKind` and `initiallySelectedFilter` on this component
               * are inert here.** `DefaultCatalogPage` reads them only to build
               * its own `DefaultFilters`, in a
               * `filters ?? <DefaultFilters ... />` -- so passing `filters`, as
               * this module must in order to host the filter extensions,
               * discards both. Setting them looked right, typechecked, and did
               * nothing; the catalog rendered `0-0 of 0`.
               *
               * The pickers themselves are what set those two filters. With
               * `catalog-filter:catalog/kind` and `.../list` disabled, nothing
               * did:
               *
               * - no kind filter, so Systems, Users and Groups join the
               *   Components;
               * - the user-list filter falls to its `'owned'` default, and
               *   nothing here is owned by the signed-in user -- 98 rows became
               *   none.
               *
               * `hidden` is safe for this because both pickers call
               * `updateFilters` from an effect and only then check it --
               * `hidden ? null : <Select/>` gates the render, never the filter.
               * Verified in `EntityKindPicker.esm.js` and
               * `UserListPicker.esm.js` rather than assumed.
               */}
              <EntityKindPicker initialFilter="component" hidden />
              <UserListPicker initialFilter="all" hidden />
              {/**
               * Project, which no stock filter provides -- see
               * `EntityProjectPicker`. Rendered here rather than registered as
               * a `catalog-filter:` extension because this module already owns
               * the slot those extensions feed, so adding one would be a longer
               * route to the same place.
               *
               * Before the extension-provided filters, so Project leads the row
               * and Owner follows: the project partitions the estate, where the
               * owner narrows within it.
               */}
              <EntityProjectPicker />
              {inputs.filters.map(filter =>
                filter.get(coreExtensionData.reactElement),
              )}
            </>
          }
          /**
           * The four columns this portal has data for, declared rather than
           * hidden with CSS.
           *
           * **This replaces a positional CSS rule in the portal theme** --
           * `thead th:nth-child(n + 4):not(:last-child):not(:nth-last-child(2))`
           * -- which existed only because the stock `page:catalog` gave no way
           * to reach the table's `columns`. Overriding the page does, and the
           * old rule carried a warning that a Backstage upgrade reordering the
           * columns would silently hide the wrong ones. This cannot: it names
           * what it wants.
           *
           * The factories rather than hand-built column objects, because each
           * one carries its own header text through `catalogTranslationRef` --
           * which is what lets `packages/app/src/modules/i18n/catalogReact.ts`
           * rename System to "Project" without touching this file.
           *
           * Dropped, and why: Type and Lifecycle are `service` and `unknown`
           * for most of the estate, Description is absent on nearly all of it,
           * and Namespace is `default` on all 124 entities.
           */
          columns={[
            CatalogTable.columns.createNameColumn({ defaultKind: 'component' }),
            CatalogTable.columns.createSystemColumn(),
            CatalogTable.columns.createOwnerColumn(),
            CatalogTable.columns.createTagsColumn(),
          ]}
          /**
           * No row actions, so material-table renders no Actions column.
           *
           * The three icons were "view in source", "edit" and "star". The first
           * two duplicate what the entity page offers a click away, and
           * starring is only useful with the Starred filter, which this page no
           * longer shows.
           */
          actions={[]}
          /**
           * Offset paging, and **omitting this is a real bug, not a default**.
           *
           * The stock extension passes `config.pagination`, which defaults to
           * `true` and puts the list in cursor mode -- server-ordered, 20 at a
           * time, prev/next only. Passing nothing drops it to `none`, and the
           * fall-through path in `CatalogTable` then sorts client-side with
           * lodash `sortBy`, which is a plain case-sensitive comparison: page
           * one silently became `Archieve`, `DAARWYN_PORTAL`, `DataAgentUI`
           * -- every capitalised name first -- instead of alphabetical.
           *
           * Offset rather than cursor because cursor mode has no total count,
           * so it can only ever render prev/next; offset knows how many rows
           * there are, which is what both the numbered buttons and the
           * "1-20 of 96" caption are computed from. It also keeps the ordering
           * on the server where it was, and fetches a page at a time rather
           * than all 96 -- the one part of this that still holds at the 10,000
           * repositories the requirements document imagines.
           */
          pagination={{ mode: 'offset', limit: 20 }}
          tableOptions={{
            /**
             * The reason for the whole module: numbered page buttons plus the
             * displayed-rows count, in place of two bare arrows.
             *
             * material-table picks its actions component off this exact value
             * -- `'normal'` gives `MTablePagination` (arrows only), anything
             * else gives `MTableSteppedPagination`.
             */
            paginationType: 'stepped',
            pageSizeOptions: [10, 20, 50, 100],
            // Without this a short last page is padded with blank rows to keep
            // the table a constant height, which on the final page of 96 reads
            // as sixteen empty rows rather than as the end of the list.
            emptyRowsWhenPaging: false,
          }}
        />
      ),
    });
  },
});

/**
 * Registered under `catalog`, not `app`.
 *
 * An extension's id comes from its kind, its plugin and its name, so a module
 * declaring `pluginId: 'app'` would produce `page:app` and add a second page
 * rather than replacing the catalog's. This is the documented way to override
 * another plugin's extension.
 */
export const catalogModule = createFrontendModule({
  pluginId: 'catalog',
  extensions: [catalogPage, hasComponentsCard],
});
