import type {
  DatabaseService,
  LifecycleService,
  LoggerService,
  RootConfigService,
} from '@backstage/backend-plugin-api';
import { DatabaseManager } from '@backstage/backend-defaults/database';

type DatabaseClient = Awaited<ReturnType<DatabaseService['getClient']>>;

/**
 * A read-only handle on the fleet plugin's database, for use from a module
 * belonging to a different plugin.
 *
 * `coreServices.database` is scoped to the plugin asking for it, so a module
 * registered under `catalog` or `search` would get that plugin's database
 * rather than fleet's. `DatabaseManager.forPlugin` resolves the same connection
 * the fleet plugin itself uses, from the same `backend.database` config.
 *
 * **Read-only by contract.** The fleet plugin owns those migrations and runs
 * them on its own startup. Nothing reached through this handle may create or
 * alter a table, and every caller must tolerate the tables not existing yet --
 * on a first boot the fleet plugin may not have migrated when a consumer
 * first asks.
 *
 * **One pool per process, shared.** Every call used to build its own
 * `DatabaseManager`, so the two consumers (the catalog module and the search
 * module) opened a connection pool each on top of the fleet plugin's own --
 * three pools to one database where every other plugin has one. Backstage
 * initialises fifteen plugins concurrently at startup, and the extra pools were
 * enough to starve the catalog plugin's `core.auth` service of a connection:
 * it died with `KnexTimeoutError: Timeout acquiring a connection`, took the
 * catalog's routes down with it, and left every page in the portal unable to
 * load an entity. Memoised so both consumers share one pool.
 */
let shared: Promise<DatabaseClient> | undefined;

export async function fleetDatabaseClient(
  config: RootConfigService,
  deps: { logger: LoggerService; lifecycle: LifecycleService },
): Promise<DatabaseClient> {
  if (!shared) {
    shared = DatabaseManager.fromConfig(config)
      .forPlugin('fleet', {
        logger: deps.logger,
        lifecycle: deps.lifecycle,
      })
      .getClient()
      .catch(error => {
        // Never cache a failure: a consumer initialising before the database
        // is reachable would otherwise poison every later caller.
        shared = undefined;
        throw error;
      });
  }
  return shared;
}

/** Test-only: drops the memoised client so each test starts clean. */
export function resetFleetDatabaseClientForTests(): void {
  shared = undefined;
}
