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
 */
export async function fleetDatabaseClient(
  config: RootConfigService,
  deps: { logger: LoggerService; lifecycle: LifecycleService },
): Promise<DatabaseClient> {
  const database = DatabaseManager.fromConfig(config).forPlugin('fleet', {
    logger: deps.logger,
    lifecycle: deps.lifecycle,
  });
  return database.getClient();
}
