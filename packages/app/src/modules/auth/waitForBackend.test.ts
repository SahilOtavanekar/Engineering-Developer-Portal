import { isBackendReachable, waitForBackend } from './waitForBackend';

/**
 * The retry policy that holds the app back until the backend answers.
 *
 * `sleep` is injected throughout, so these run instantly and none of them
 * depends on a real timer -- the repo already records that wall-clock
 * assertions are worthless on a loaded machine.
 */
describe('isBackendReachable', () => {
  /**
   * The whole point of the gate. Measured across a restart: the port opens
   * five seconds before any plugin route works, and every route answers 404
   * in between. Treating 404 as reachable would let the app through into
   * exactly the broken state this exists to prevent.
   */
  it('treats 404 as not yet mounted', () => {
    expect(isBackendReachable(404)).toBe(false);
  });

  /**
   * The probe is unauthenticated, so a healthy catalog MUST reject it.
   * Waiting for 200 would wait for ever.
   */
  it('treats 401 as reachable, because an unauthenticated probe cannot get 200', () => {
    expect(isBackendReachable(401)).toBe(true);
  });

  it('treats a failed request as not yet listening', () => {
    expect(isBackendReachable(undefined)).toBe(false);
  });

  it('treats a served response as reachable', () => {
    expect(isBackendReachable(200)).toBe(true);
  });

  /**
   * A backend that is up but unwell is still up. Sitting on the splash screen
   * would hide a real error behind a spinner, which is the failure mode this
   * whole change exists to remove.
   */
  it('treats a server error as reachable, so the app can show the real error', () => {
    expect(isBackendReachable(500)).toBe(true);
  });
});

describe('waitForBackend', () => {
  const noSleep = () => Promise.resolve();

  it('returns immediately when the backend already answers', async () => {
    const probe = jest.fn().mockResolvedValue(401);

    await expect(waitForBackend({ probe, sleep: noSleep })).resolves.toBe(
      'ready',
    );
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('keeps polling through the not-listening and 404 phases', async () => {
    // The measured startup, compressed: refused, refused, then the window
    // where the port is open but routes are not mounted, then ready.
    const probe = jest
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(404)
      .mockResolvedValueOnce(401);

    await expect(waitForBackend({ probe, sleep: noSleep })).resolves.toBe(
      'ready',
    );
    expect(probe).toHaveBeenCalledTimes(4);
  });

  /**
   * A probe that rejects is an attempt that failed, not a wait that failed.
   * `fetch` throws outright while nothing is listening, which is the normal
   * state for the first two minutes.
   */
  it('survives a probe that throws', async () => {
    const probe = jest
      .fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce(401);

    await expect(waitForBackend({ probe, sleep: noSleep })).resolves.toBe(
      'ready',
    );
    expect(probe).toHaveBeenCalledTimes(2);
  });

  /**
   * Bounded on purpose: a backend that never arrives must end in the app's
   * ordinary error path rather than a spinner nobody can get past.
   */
  it('gives up after the configured attempts', async () => {
    const probe = jest.fn().mockResolvedValue(404);

    await expect(
      waitForBackend({ probe, sleep: noSleep, attempts: 3 }),
    ).resolves.toBe('gave-up');
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it('does not sleep after the final attempt', async () => {
    const sleep = jest.fn().mockResolvedValue(undefined);
    const probe = jest.fn().mockResolvedValue(404);

    await waitForBackend({ probe, sleep, attempts: 3 });

    // Two gaps between three attempts, never a trailing one.
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('waits the configured interval between attempts', async () => {
    const sleep = jest.fn().mockResolvedValue(undefined);
    const probe = jest
      .fn()
      .mockResolvedValueOnce(404)
      .mockResolvedValueOnce(401);

    await waitForBackend({ probe, sleep, intervalMs: 250 });

    expect(sleep).toHaveBeenCalledWith(250);
  });

  /**
   * Unmounting must stop the loop. Without this a component that mounts and
   * unmounts repeatedly would leave probes running for the full five minutes.
   */
  it('stops when cancelled and reports it', async () => {
    const probe = jest.fn().mockResolvedValue(404);
    let cancelled = false;

    const result = await waitForBackend({
      probe,
      sleep: noSleep,
      isCancelled: () => cancelled,
      attempts: 50,
    });

    // Sanity: without cancelling it runs to the cap.
    expect(result).toBe('gave-up');
    expect(probe).toHaveBeenCalledTimes(50);

    probe.mockClear();
    cancelled = true;
    await expect(
      waitForBackend({
        probe,
        sleep: noSleep,
        isCancelled: () => cancelled,
        attempts: 50,
      }),
    ).resolves.toBe('cancelled');
    expect(probe).not.toHaveBeenCalled();
  });
});
