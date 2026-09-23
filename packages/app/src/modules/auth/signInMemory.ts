/**
 * Make the portal open on the sign-in page, without signing people out of
 * every refresh.
 *
 * THE KEY. `useSignInProviders` in `@backstage/core-components` reads
 * `PROVIDER_STORAGE_KEY` on mount. Absent, it renders the provider picker.
 * Present, it runs that provider's loader and signs straight in, so the
 * picker never appears and the app lands on the catalog. There is no prop and
 * no config for this -- neither `SignInPage` nor `getSignInProviders` exposes
 * a way to disable the automatic sign-in, so clearing the key is the only
 * lever. Verified by searching every `@backstage` package: exactly one file
 * reads it, `core-components`' `layout/SignInPage/providers.esm.js`, so
 * clearing it is sufficient rather than partial.
 *
 * WHY ONCE PER SESSION, NOT ONCE PER LOAD. Clearing it on every render was
 * the first version and it was wrong: a browser reload is a fresh render, so
 * every refresh -- and every deep link into a repository page -- threw the
 * user back to the picker. `packages/app/e2e-tests/performance.test.ts`
 * caught it, because it signs in once and then calls `page.goto()` five times
 * per sample; the second load had no session and the row it waits for never
 * appeared.
 *
 * `sessionStorage` is exactly the right scope. It survives reloads and
 * in-tab navigation, and is empty in a new tab or a newly started browser --
 * which is what "when I run the app it should start from the sign-in page"
 * actually means.
 *
 * **This is an internal, undocumented key.** If a future Backstage renames
 * it, this silently stops working and the automatic sign-in quietly returns
 * -- the same failure mode as the `aria-label*="favorite"` rule. The test
 * pins the exact string so a rename is at least visible in a diff.
 */
export const PROVIDER_STORAGE_KEY = '@backstage/core:SignInPage:provider';

/** Ours, so it carries a `portal:` prefix rather than pretending to be BUI's. */
export const SESSION_MARKER_KEY = 'portal:signInOffered';

export interface SignInMemoryStorages {
  /** Where core-components remembers the provider. */
  local?: Pick<Storage, 'removeItem'> | null;
  /** Scoped to the tab, so a reload does not count as a new start. */
  session?: Pick<Storage, 'getItem' | 'setItem'> | null;
}

/**
 * Show the picker on the first load of a browser session; stay signed in
 * afterwards.
 *
 * Returns whether it actually cleared anything, which is what the test reads.
 *
 * Every access is wrapped: storage throws outright in some contexts -- a
 * private window with site data blocked, for one -- and failing to sign in
 * because a *convenience* key could not be read would be a far worse bug than
 * the one this exists to fix. On failure the picker simply shows, which is
 * the safe outcome.
 */
export function ensureSignInPageOnNewSession(
  storages: SignInMemoryStorages = {
    local: globalThis.localStorage,
    session: globalThis.sessionStorage,
  },
): boolean {
  const { local, session } = storages;

  try {
    if (session?.getItem(SESSION_MARKER_KEY)) {
      // Already offered in this tab. A reload or an in-app navigation must
      // not sign the user out.
      return false;
    }
    session?.setItem(SESSION_MARKER_KEY, '1');
    local?.removeItem(PROVIDER_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}
