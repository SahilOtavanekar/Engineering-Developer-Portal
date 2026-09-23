import { useEffect, useRef, useState } from 'react';
import { Progress, SignInPage } from '@backstage/core-components';
import {
  discoveryApiRef,
  githubAuthApiRef,
  useApi,
} from '@backstage/core-plugin-api';
import {
  SignInPageBlueprint,
  type SignInPageProps,
} from '@backstage/plugin-app-react';
import { ensureSignInPageOnNewSession } from './signInMemory';
import { waitForBackend } from './waitForBackend';

const githubProvider = {
  id: 'github-auth-provider',
  title: 'GitHub',
  message: 'Sign in using GitHub',
  apiRef: githubAuthApiRef,
};

/**
 * Shown while the backend is still coming up.
 *
 * Deliberately says which half is missing. "Loading..." on its own is what
 * sent this bug round the houses in the first place -- the page looked like a
 * portal that had failed rather than one that had not started.
 */
function StartingUp() {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        // Full height: this renders instead of the app, with no header above
        // it, so anything less leaves the panel sitting a quarter of the way
        // down the page rather than centred.
        minHeight: '100vh',
        gap: 16,
        padding: 24,
        textAlign: 'center',
      }}
    >
      <div style={{ width: 'min(320px, 80vw)' }}>
        <Progress />
      </div>
      <div style={{ fontSize: 16, fontWeight: 600 }}>Starting the portal</div>
      <div style={{ fontSize: 14, maxWidth: '44ch', opacity: 0.75 }}>
        Waiting for the backend to accept requests. After a fresh
        {' "yarn start" '}
        this takes a couple of minutes while the bundle compiles.
      </div>
    </div>
  );
}

/**
 * Holds the whole app back until the backend can actually answer.
 *
 * **Why here.** `SignInPage` is rendered instead of the app until it passes an
 * identity up, so it is the one component that reliably gates everything --
 * routes, cards and the catalog's own data fetching included. Gating inside
 * the catalog page would fix one page and leave the fleet and productivity
 * pages with the same defect.
 *
 * **What it fixes.** Loading the portal during the ~2.5 minutes after
 * `yarn start` used to produce "Could not fetch catalog entities" and "Failed
 * to load entity kinds", and the app never recovered on its own: the sign-in
 * flow ran against a dead backend, failed, and nothing retried. Worse, a
 * failed auto-sign-in *clears* the remembered provider
 * (`localStorage['@backstage/core:SignInPage:provider']`), so the next load
 * also had to be driven by hand. Waiting first means the sign-in only ever
 * runs against a backend that answers, and the entities load normally.
 *
 * **What it does not fix, and cannot from here.** A tab that is ALREADY
 * rendered when the backend restarts has passed this gate, so it still shows
 * the catalog error until it is reloaded. Recovering that would mean retrying
 * inside the data layer, which is Backstage's own `EntityListProvider`.
 */
function GatedSignInPage(props: SignInPageProps) {
  const discoveryApi = useApi(discoveryApiRef);
  const [ready, setReady] = useState(false);

  // On the first load of a browser session, forget the last provider so the
  // picker is shown rather than skipped by an automatic sign-in. A reload or
  // an in-app navigation keeps the session -- see `signInMemory.ts` for why
  // clearing it on every load was wrong.
  //
  // Done DURING RENDER, not in an effect, and that is load-bearing: the
  // reader is `useSignInProviders`' `useLayoutEffect` inside `SignInPage`,
  // and a parent's effects run *after* a child's layout effects. Clearing it
  // in `useEffect` would therefore run too late on the very first mount --
  // the automatic sign-in would already have started. A ref makes it happen
  // exactly once, before the child can ever mount.
  const offered = useRef(false);
  if (!offered.current) {
    offered.current = true;
    ensureSignInPageOnNewSession();
  }

  useEffect(() => {
    let cancelled = false;

    waitForBackend({
      isCancelled: () => cancelled,
      sleep: ms =>
        new Promise(resolve => {
          setTimeout(resolve, ms);
        }),
      probe: async () => {
        // The catalog specifically: it is what the landing page loads, and the
        // plugin whose absence produced the reported error. An unauthenticated
        // GET is enough -- see `isBackendReachable`.
        const baseUrl = await discoveryApi.getBaseUrl('catalog');
        const response = await fetch(`${baseUrl}/entities?limit=1`);
        return response.status;
      },
    }).then(outcome => {
      // `gave-up` still renders: a backend that never arrives should surface
      // the app's ordinary error, not an endless spinner.
      if (!cancelled && outcome !== 'cancelled') {
        setReady(true);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [discoveryApi]);

  if (!ready) {
    return <StartingUp />;
  }

  return <SignInPage {...props} providers={['guest', githubProvider]} />;
}

/**
 * Overrides the built-in `sign-in-page:app` extension, which only offers the
 * guest provider. Because this extension is registered under pluginId 'app'
 * with no name, it resolves to the same extension id and replaces the default.
 */
export const AppSignInPage = SignInPageBlueprint.make({
  params: {
    loader: async () => (props: SignInPageProps) =>
      <GatedSignInPage {...props} />,
  },
});
