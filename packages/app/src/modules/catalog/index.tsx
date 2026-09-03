import {
  coreExtensionData,
  createExtensionInput,
  createFrontendModule,
  PageBlueprint,
} from '@backstage/frontend-plugin-api';
import catalogPlugin, {
  CatalogIndexPage,
} from '@backstage/plugin-catalog/alpha';
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
              {inputs.filters.map(filter =>
                filter.get(coreExtensionData.reactElement),
              )}
            </>
          }
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
  extensions: [catalogPage],
});
