import {
  coreServices,
  createBackendModule,
  type DatabaseService,
} from '@backstage/backend-plugin-api';
import { startTestBackend } from '@backstage/backend-test-utils';
import { fleetPlugin } from '../plugin';

type DatabaseClient = Awaited<ReturnType<DatabaseService['getClient']>>;

export interface FleetTestDatabase {
  client: DatabaseClient;
  stop(): Promise<void>;
}

/**
 * Boots the fleet plugin against a throwaway database so tests exercise the
 * real migrations rather than a hand-built schema. Test-only; never exported
 * from the plugin's public entry point.
 */
export async function startFleetTestDatabase(): Promise<FleetTestDatabase> {
  let captured: DatabaseClient | undefined;

  const probe = createBackendModule({
    pluginId: 'fleet',
    moduleId: 'test-database-probe',
    register(reg) {
      reg.registerInit({
        deps: { database: coreServices.database },
        async init({ database }) {
          captured = await database.getClient();
        },
      });
    },
  });

  const backend = await startTestBackend({ features: [fleetPlugin, probe] });

  if (!captured) {
    throw new Error('fleet plugin did not initialise a database');
  }

  return { client: captured, stop: () => backend.stop() };
}
