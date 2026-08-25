import type { SyncStateRecord } from '../database/SyncStateStore';
import { backoffDelayMs, describeBackoff, shouldSkip } from './backoff';

const MINUTE = 60_000;
const NOW = new Date('2026-08-21T12:00:00.000Z');

function state(
  consecutiveFailures: number,
  lastAttemptMinutesAgo: number,
): SyncStateRecord {
  return {
    resource: 'repositories:demandai',
    cursor: null,
    last_attempt_at: new Date(NOW.getTime() - lastAttemptMinutesAgo * MINUTE),
    last_success_at: null,
    consecutive_failures: consecutiveFailures,
    last_error: 'boom',
  };
}

describe('backoffDelayMs', () => {
  const opts = { baseMs: 15 * MINUTE, maxMs: 360 * MINUTE };

  it('does not delay a resource that has not failed', () => {
    expect(backoffDelayMs(0, opts)).toBe(0);
    expect(backoffDelayMs(-1, opts)).toBe(0);
  });

  it('doubles with each successive failure', () => {
    expect(backoffDelayMs(1, opts)).toBe(15 * MINUTE);
    expect(backoffDelayMs(2, opts)).toBe(30 * MINUTE);
    expect(backoffDelayMs(3, opts)).toBe(60 * MINUTE);
    expect(backoffDelayMs(4, opts)).toBe(120 * MINUTE);
  });

  it('stops doubling at the ceiling', () => {
    expect(backoffDelayMs(6, opts)).toBe(360 * MINUTE);
    expect(backoffDelayMs(20, opts)).toBe(360 * MINUTE);
  });

  it('still retries eventually, however long it has been broken', () => {
    // A resource broken for a month must not back off to never: whatever broke
    // it may have been fixed and nothing else will notice.
    expect(backoffDelayMs(1000, opts)).toBe(360 * MINUTE);
    expect(Number.isFinite(backoffDelayMs(1000, opts))).toBe(true);
  });
});

describe('shouldSkip', () => {
  const opts = { baseMs: 15 * MINUTE, maxMs: 360 * MINUTE };

  it('runs a resource with no recorded state', () => {
    expect(shouldSkip(undefined, NOW, opts)).toBe(false);
  });

  it('runs a healthy resource', () => {
    expect(shouldSkip(state(0, 1), NOW, opts)).toBe(false);
  });

  it('skips while the delay has not elapsed', () => {
    // One failure, 5 minutes ago, 15 minute delay.
    expect(shouldSkip(state(1, 5), NOW, opts)).toBe(true);
  });

  it('runs once the delay has elapsed', () => {
    expect(shouldSkip(state(1, 20), NOW, opts)).toBe(false);
  });

  it('waits longer the more times it has failed', () => {
    // 45 minutes since the attempt: past a 30 minute delay, short of 60.
    expect(shouldSkip(state(2, 45), NOW, opts)).toBe(false);
    expect(shouldSkip(state(3, 45), NOW, opts)).toBe(true);
  });

  it('runs when the delay elapsed exactly', () => {
    expect(shouldSkip(state(1, 15), NOW, opts)).toBe(false);
  });

  it('runs when there is no attempt timestamp to measure from', () => {
    expect(
      shouldSkip({ ...state(5, 0), last_attempt_at: null }, NOW, opts),
    ).toBe(false);
  });

  it('tolerates a failure count arriving as a string from the driver', () => {
    const fromPostgres = {
      ...state(1, 5),
      consecutive_failures: '1' as unknown as number,
    };

    expect(shouldSkip(fromPostgres, NOW, opts)).toBe(true);
  });
});

describe('describeBackoff', () => {
  const opts = { baseMs: 15 * MINUTE, maxMs: 360 * MINUTE };

  it('says how many failures and how long the wait is', () => {
    expect(describeBackoff(state(3, 10), NOW, opts)).toBe(
      '3 consecutive failures, retrying in ~50 minutes',
    );
  });

  it('singularises a single failure', () => {
    expect(describeBackoff(state(1, 14), NOW, opts)).toBe(
      '1 consecutive failure, retrying in ~1 minute',
    );
  });

  it('never reports a negative wait', () => {
    expect(describeBackoff(state(1, 999), NOW, opts)).toContain('~0 minutes');
  });
});
