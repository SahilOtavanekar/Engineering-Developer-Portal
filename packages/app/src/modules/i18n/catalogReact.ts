import { TranslationBlueprint } from '@backstage/plugin-app-react';
import { createTranslationMessages } from '@backstage/frontend-plugin-api';
import { catalogReactTranslationRef } from '@backstage/plugin-catalog-react/alpha';

/**
 * Renames the System column to Project.
 *
 * Backstage's `System` is the closest concept it has to a Bitbucket project,
 * and the entity provider fills the column from `project_key` -- so every
 * value in it is a Bitbucket project key (AM, MDLH, DDS, DAARWYN, RES,
 * DAIWEB). Calling the column "System" asks the reader to translate.
 *
 * Column titles come from `EntityTableColumnTitle`, which resolves
 * `entityTableColumnTitle.<key>` against this ref, so the header is not
 * reachable through the table's `columns` prop or any CSS -- the translation
 * ref is the supported route, and the only one.
 *
 * This renames the column wherever that key is used, which is the point: an
 * entity table on one page and the catalog on another should not disagree
 * about what the concept is called.
 */
export const catalogReactMessages = createTranslationMessages({
  ref: catalogReactTranslationRef,
  messages: {
    'entityTableColumnTitle.system': 'Project',
  },
});

export const catalogReactTranslations = TranslationBlueprint.make({
  name: 'catalog-react',
  params: { resource: catalogReactMessages },
});
