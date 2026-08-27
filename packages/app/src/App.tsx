import { createApp } from '@backstage/frontend-defaults';
import catalogPlugin from '@backstage/plugin-catalog/alpha';
import { navModule } from './modules/nav';
import { authModule } from './modules/auth';
import { i18nModule } from './modules/i18n';

export default createApp({
  features: [catalogPlugin, navModule, authModule, i18nModule],
});
