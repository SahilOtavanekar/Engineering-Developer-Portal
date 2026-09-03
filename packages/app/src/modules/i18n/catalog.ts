import { TranslationBlueprint } from '@backstage/plugin-app-react';
import { createTranslationMessages } from '@backstage/frontend-plugin-api';
import { catalogTranslationRef } from '@backstage/plugin-catalog/alpha';

/**
 * Drops the catalog page's own heading.
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
export const catalogMessages = createTranslationMessages({
  ref: catalogTranslationRef,
  messages: {
    'indexPage.title': '',
  },
});

export const catalogTranslations = TranslationBlueprint.make({
  name: 'catalog',
  params: { resource: catalogMessages },
});
