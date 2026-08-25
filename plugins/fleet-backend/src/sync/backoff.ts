import type { SyncStateRecord } from '../database/SyncStateStore';

export interface BackoffOptions {
  /** Delay after the first failure. Doubles thereafter. Defaults to 15 minutes. */
  baseMs?: number;
  /** Ceiling on the delay, so a permanently broken resource still retries. */
  maxMs?: number;
}

const DEFAULT_BASE_MS = 15 * 60 * 1000;
const DEFAULT_MAX_MS = 6 * 60 * 60 * 1000;

/**
 * How long to wait before retrying, given a run of consecutive failures.
 *
 * Doubles each time and then flattens. The ceiling matters: a resource that is
 * broken for a week should still be retried every few hours, because whatever
 * broke it may have been fixed and nothing else will notice.
 */
export function backoffDelayMs(
  consecutiveFailures: number,
  options: BackoffOptions = {},
): number {
  const base = options.baseMs ?? DEFAULT_BASE_MS;
  const max = options.maxMs ?? DEFAULT_MAX_MS;

  if (consecutiveFailures <= 0) return 0;

  // 2^30 ms is already far beyond the ceiling; capping the exponent keeps the
  // arithmetic finite for an absurd failure count.
  const exponent = Math.min(consecutiveFailures - 1, 30);
  return Math.min(max, base * 2 ** exponent);
}

/**
 * Whether a scheduled resource should sit this cycle out.
 *
 * Without this, a repeatedly failing resource retries at full cadence forever,
 * spending API quota on something that is not going to work -- and burying the
 * successful syncs in its noise.
 */
export function shouldSkip(
  state: SyncStateRecord | undefined,
  now: Date = new Date(),
  options: BackoffOptions = {},
): boolean {
  if (!state) return false;

  const failures = Number(state.consecutive_failures ?? 0);
  if (failures <= 0) return false;

  const lastAttempt = state.last_attempt_at
    ? new Date(state.last_attempt_at)
    : undefined;
  // No recorded attempt means nothing to measure the delay from; run it.
  if (!lastAttempt || Number.isNaN(lastAttempt.getTime())) return false;

  const readyAt = lastAttempt.getTime() + backoffDelayMs(failures, options);
  return now.getTime() < readyAt;
}

/** Human-readable remaining wait, for logging. */
export function describeBackoff(
  state: SyncStateRecord,
  now: Date = new Date(),
  options: BackoffOptions = {},
): string {
  const failures = Number(state.consecutive_failures ?? 0);
  const lastAttempt = new Date(state.last_attempt_at as unknown as string);
  const readyAt = lastAttempt.getTime() + backoffDelayMs(failures, options);
  const minutes = Math.max(0, Math.ceil((readyAt - now.getTime()) / 60_000));

  return `${failures} consecutive failure${
    failures === 1 ? '' : 's'
  }, retrying in ~${minutes} minute${minutes === 1 ? '' : 's'}`;
}
