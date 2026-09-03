import { createApp } from '@backstage/frontend-defaults';
import catalogPlugin from '@backstage/plugin-catalog/alpha';
import { navModule } from './modules/nav';
import { authModule } from './modules/auth';
import { i18nModule } from './modules/i18n';
import { themeModule } from './modules/theme';
import { catalogModule } from './modules/catalog';

export default createApp({
  features: [
    catalogPlugin,
    // After `catalogPlugin`: this module overrides one of its extensions, and
    // the later registration is the one that wins.
    catalogModule,
    navModule,
    authModule,
    i18nModule,
    themeModule,
  ],
});
