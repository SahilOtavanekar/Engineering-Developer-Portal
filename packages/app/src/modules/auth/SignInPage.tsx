import { SignInPage } from '@backstage/core-components';
import { githubAuthApiRef } from '@backstage/core-plugin-api';
import {
  SignInPageBlueprint,
  type SignInPageProps,
} from '@backstage/plugin-app-react';

const githubProvider = {
  id: 'github-auth-provider',
  title: 'GitHub',
  message: 'Sign in using GitHub',
  apiRef: githubAuthApiRef,
};

/**
 * Overrides the built-in `sign-in-page:app` extension, which only offers the
 * guest provider. Because this extension is registered under pluginId 'app'
 * with no name, it resolves to the same extension id and replaces the default.
 */
export const AppSignInPage = SignInPageBlueprint.make({
  params: {
    loader: async () => (props: SignInPageProps) =>
      <SignInPage {...props} providers={['guest', githubProvider]} />,
  },
});
