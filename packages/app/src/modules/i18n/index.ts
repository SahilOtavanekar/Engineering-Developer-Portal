import { createFrontendModule } from '@backstage/frontend-plugin-api';
import { userSettingsTranslations } from './userSettings';
import { catalogTranslations } from './catalog';
import { catalogReactTranslations } from './catalogReact';

/**
 * String overrides for third-party plugins.
 *
 * `TranslationBlueprint` is documented as limited to the app plugin, so this
 * module registers under `app` -- the same pluginId the nav and auth modules
 * use.
 */
export const i18nModule = createFrontendModule({
  pluginId: 'app',
  extensions: [
    userSettingsTranslations,
    catalogTranslations,
    catalogReactTranslations,
  ],
});
