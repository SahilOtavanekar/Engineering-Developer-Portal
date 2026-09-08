import { TranslationBlueprint } from '@backstage/plugin-app-react';
import { createTranslationMessages } from '@backstage/frontend-plugin-api';
import { catalogTranslationRef } from '@backstage/plugin-catalog/alpha';

/**
 * Drops the catalog page's own heading, and calls a System a Project.
 *
 * `indexPage.title` defaults to `{{orgName}} Catalog`, which rendered as a
 * 30px "Demand AI Catalog" directly beneath a breadcrumb already reading
 * "Catalog" -- the same word twice, and the organisation name a third time
 * after the sidebar logo.
 *
 * Blanked through the translation ref because that is the only thing that
 * reaches it: the title is computed inside `NfsDefaultCatalogPage` from
 * `organization.name`, so no `app-config.yaml` value and no `extensions:`
 * override can change it. Same mechanism as the user-settings strings.
 *
 * The key is type-checked against the ref, so a rename upstream fails
 * `yarn tsc` rather than silently restoring the heading.
 */
/**
 * `entityLabels.systemLabel` is the second half, and it is the entity page's
 * header rather than the catalog's.
 *
 * `EntityHeaderBui` builds its metadata row from `entityLabels.*` -- Lifecycle,
 * Owner, then one label per `partOf` relation, chosen by the related entity's
 * kind. A repository that belongs to a Bitbucket project is `partOf` a System,
 * so the header read "System: DDS" while the catalog column beside it read
 * "Project". The two now agree.
 *
 * The catalog column is renamed separately, in `catalogReact.ts`: column titles
 * resolve against `catalogReactTranslationRef` and the header against
 * `catalogTranslationRef`, so one word needs an entry in each.
 */
export const catalogMessages = createTranslationMessages({
  ref: catalogTranslationRef,
  messages: {
    'indexPage.title': '',
    'entityLabels.systemLabel': 'Project',
  },
});

export const catalogTranslations = TranslationBlueprint.make({
  name: 'catalog',
  params: { resource: catalogMessages },
});
