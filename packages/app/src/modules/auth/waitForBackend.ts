/**
 * Wait for the backend to actually serve plugin routes.
 *
 * Kept apart from the React component so the retry policy can be tested with
 * plain fakes -- no timers, no DOM, no api mocks.
 *
 * WHY 404 IS THE INTERESTING STATUS, measured across a restart 2026-09-23:
 *
 *   t=0     `yarn start`; Rspack compiles, no backend process exists
 *   t=143s  "Listening on :7007" -- the port opens, but every plugin route
 *           returns 404 while plugins register
 *   t=148s  plugins finish; auth, catalog and fleet all answer together
 *
 * So the port opening is five seconds early, and
 * `/.backstage/health/v1/readiness` is worse -- it was still 503 at 148s while
 * three plugins were already serving 200. The only signal that means "a
 * browser can use this" is a plugin route answering something other than 404.
 *
 * 401 counts as reachable and that is the whole point: the probe is
 * unauthenticated, so a mounted catalog *must* reject it. Waiting for 200
 * would wait forever.
 */

/** What a single probe attempt saw. `undefined` means the request never landed. */
export type ProbeResult = number | undefined;

export interface WaitForBackendOptions {
  /** Resolves to an HTTP status, or `undefined` if the request failed outright. */
  probe: () => Promise<ProbeResult>;
  /** Injected so tests need no real timers. */
  sleep: (ms: number) => Promise<void>;
  /** Give up after this many attempts. */
  attempts?: number;
  intervalMs?: number;
  /** Lets the caller abandon the loop on unmount. */
  isCancelled?: () => boolean;
}

/**
 * Roughly five minutes at the default interval.
 *
 * Generous on purpose: a cold `yarn start` on this repo measured 148s once and
 * 192s a few minutes later, so a two-minute cap would give up on a perfectly
 * healthy boot. It is capped at all only so that a genuinely broken backend
 * ends in the app's ordinary error path rather than an eternal spinner.
 */
const DEFAULT_ATTEMPTS = 300;
const DEFAULT_INTERVAL_MS = 1000;

/** A mounted plugin answers anything but 404. See the note above. */
export function isBackendReachable(status: ProbeResult): boolean {
  if (status === undefined) {
    // Nothing listening yet -- still compiling.
    return false;
  }
  // 404 means the root router is up but this plugin has not registered.
  return status !== 404;
}

/**
 * Polls until a plugin route answers, or the attempts run out.
 *
 * Returns `gave-up` rather than throwing: the caller renders the app anyway,
 * so a backend that never arrives produces the normal "could not fetch"
 * error, which is honest, instead of a spinner that never resolves.
 */
export async function waitForBackend(
  options: WaitForBackendOptions,
): Promise<'ready' | 'gave-up' | 'cancelled'> {
  const {
    probe,
    sleep,
    attempts = DEFAULT_ATTEMPTS,
    intervalMs = DEFAULT_INTERVAL_MS,
    isCancelled = () => false,
  } = options;

  for (let attempt = 0; attempt < attempts; attempt++) {
    if (isCancelled()) {
      return 'cancelled';
    }

    // A thrown probe is a failed attempt, not a failed wait: the dev server
    // refusing connections is the expected state for the first two minutes.
    const status = await probe().catch(() => undefined);

    if (isBackendReachable(status)) {
      return 'ready';
    }

    // No sleep after the final attempt -- it would only delay the give-up.
    if (attempt < attempts - 1) {
      await sleep(intervalMs);
    }
  }

  return 'gave-up';
}
