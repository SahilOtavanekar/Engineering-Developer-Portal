import {
  PROVIDER_STORAGE_KEY,
  SESSION_MARKER_KEY,
  ensureSignInPageOnNewSession,
} from './signInMemory';

/** A sessionStorage stand-in, so nothing here depends on a real browser. */
const fakeSession = (seed: Record<string, string> = {}) => {
  const data = new Map(Object.entries(seed));
  return {
    getItem: jest.fn((k: string) => data.get(k) ?? null),
    setItem: jest.fn((k: string, v: string) => {
      data.set(k, v);
    }),
  };
};

/**
 * Clearing the remembered provider is what makes the portal open on the
 * sign-in page instead of signing in silently and landing on the catalog.
 * Scoping it to a browser session is what stops that logging people out of
 * every refresh.
 */
describe('ensureSignInPageOnNewSession', () => {
  /**
   * Pinned as a literal on purpose. The key belongs to `core-components` and
   * is not part of its public API, so a rename upstream would silently
   * restore the automatic sign-in with nothing failing. This at least makes
   * the string visible in a diff when the dependency is bumped.
   */
  it('targets the key core-components actually reads', () => {
    expect(PROVIDER_STORAGE_KEY).toBe('@backstage/core:SignInPage:provider');
  });

  it('forgets the provider on the first load of a session', () => {
    const local = { removeItem: jest.fn() };
    const session = fakeSession();

    expect(ensureSignInPageOnNewSession({ local, session })).toBe(true);
    expect(local.removeItem).toHaveBeenCalledWith(PROVIDER_STORAGE_KEY);
    expect(session.setItem).toHaveBeenCalledWith(SESSION_MARKER_KEY, '1');
  });

  /**
   * The regression `performance.test.ts` caught. It signs in once and then
   * calls `page.goto()` five times per sample; clearing on every load meant
   * the second navigation had no session and the row it waits for never
   * appeared. A reload must not sign anybody out.
   */
  it('leaves the provider alone on a reload within the same session', () => {
    const local = { removeItem: jest.fn() };
    const session = fakeSession({ [SESSION_MARKER_KEY]: '1' });

    expect(ensureSignInPageOnNewSession({ local, session })).toBe(false);
    expect(local.removeItem).not.toHaveBeenCalled();
  });

  it('forgets again in a new session, which is a new tab or a new browser', () => {
    const local = { removeItem: jest.fn() };

    ensureSignInPageOnNewSession({ local, session: fakeSession() });
    ensureSignInPageOnNewSession({ local, session: fakeSession() });

    expect(local.removeItem).toHaveBeenCalledTimes(2);
  });

  it('only offers once even if called repeatedly in one session', () => {
    const local = { removeItem: jest.fn() };
    const session = fakeSession();

    expect(ensureSignInPageOnNewSession({ local, session })).toBe(true);
    expect(ensureSignInPageOnNewSession({ local, session })).toBe(false);
    expect(local.removeItem).toHaveBeenCalledTimes(1);
  });

  /**
   * Storage access throws outright in some contexts -- a private window with
   * site data blocked, for one. Failing to sign in because a convenience key
   * could not be read would be a worse bug than the one this fixes, and the
   * picker is shown either way.
   */
  it('survives storage that throws', () => {
    const local = {
      removeItem: jest.fn(() => {
        throw new Error('access denied');
      }),
    };
    const session = fakeSession();

    expect(() =>
      ensureSignInPageOnNewSession({ local, session }),
    ).not.toThrow();
  });

  it('survives storage being absent', () => {
    expect(() =>
      ensureSignInPageOnNewSession({ local: null, session: null }),
    ).not.toThrow();
  });
});
