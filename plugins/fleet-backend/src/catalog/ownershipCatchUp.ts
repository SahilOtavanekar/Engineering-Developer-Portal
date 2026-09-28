import type { LoggerService } from '@backstage/backend-plugin-api';

/**
 * Whether the fleet ownership pass has finished at least once for a
 * workspace. Absent means the provider has no way to ask, and never waits.
 */
export type OwnershipReady = (workspace: string) => Promise<boolean>;

export interface OwnershipCatchUpOptions {
  /** How often to look again. Defaults to 30 seconds. */
  intervalMs?: number;
  /**
   * How long to keep looking. Defaults to 8 minutes, inside the providers'
   * task timeouts, after which the ordinary 30-minute cycle takes over.
   */
  maxWaitMs?: number;
  /** Injected by tests so waiting is instant. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_MAX_WAIT_MS = 8 * 60_000;

/**
 * Runs `refresh`, and if ownership had not resolved yet, runs it again as soon
 * as it has.
 *
 * The first-boot ordering problem this exists for: the catalog providers first
 * run 10-15 seconds after boot, the fleet ownership pass about 145 seconds
 * after, and the providers then wait out a 30-minute cycle. Measured
 * 2026-09-27 on a fresh install: every component registered as
 * `group:default/unowned` and no derived User existed, until the next cycle.
 * A longer fixed initial delay would only move the race, so this waits on
 * the fact itself.
 *
 * Only a first boot ever waits: once ownership has resolved, `ready` stays
 * true and every later tick is a single refresh.
 */
export async function refreshWithOwnershipCatchUp(options: {
  workspace: string;
  label: string;
  refresh: () => Promise<void>;
  ready?: OwnershipReady;
  logger: LoggerService;
  catchUp?: OwnershipCatchUpOptions;
}): Promise<void> {
  const { workspace, label, refresh, ready, logger } = options;
  const wasReady = ready ? await ready(workspace) : true;
  await refresh();
  if (wasReady) return;

  const interval = options.catchUp?.intervalMs ?? DEFAULT_INTERVAL_MS;
  const maxWait = options.catchUp?.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const sleep =
    options.catchUp?.sleep ??
    ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));

  logger.info(
    `${label} for '${workspace}' ran before ownership resolved; ` +
      `refreshing again as soon as it does`,
  );
  for (let waited = 0; waited < maxWait; waited += interval) {
    await sleep(interval);
    if (await ready!(workspace)) {
      await refresh();
      return;
    }
  }
  logger.info(
    `${label} for '${workspace}': ownership still unresolved after ` +
      `${Math.round(maxWait / 60_000)} minutes; the next scheduled run will ` +
      `pick it up`,
  );
}
