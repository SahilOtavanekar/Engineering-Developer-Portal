import { createFrontendModule } from '@backstage/frontend-plugin-api';
import { AppSignInPage } from './SignInPage';

export const authModule = createFrontendModule({
  pluginId: 'app',
  extensions: [AppSignInPage],
});
