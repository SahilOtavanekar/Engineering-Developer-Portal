import {
  coreServices,
  createBackendModule,
  type DatabaseService,
} from '@backstage/backend-plugin-api';
import { startTestBackend } from '@backstage/backend-test-utils';
import { fleetPlugin } from './plugin';

/**
 * Derived from the service rather than imported from 'knex' directly. The repo
 * resolves more than one copy of knex, and importing the type independently
 * binds the test to whichever copy hoists to the root -- which is not
 * necessarily the one backend-plugin-api hands back.
 */
type DatabaseClient = Awaited<ReturnType<DatabaseService['getClient']>>;

/**
 * Captures the plugin's database handle so the tests can inspect what the
 * migrations actually produced, rather than trusting that they ran.
 */
function databaseProbe(capture: (client: DatabaseClient) => void) {
  return createBackendModule({
    pluginId: 'fleet',
    moduleId: 'test-database-probe',
    register(reg) {
      reg.registerInit({
        deps: { database: coreServices.database },
        async init({ database }) {
          capture(await database.getClient());
        },
      });
    },
  });
}

describe('fleetPlugin', () => {
  let backend: Awaited<ReturnType<typeof startTestBackend>>;
  let client: DatabaseClient;

  beforeAll(async () => {
    let captured: DatabaseClient | undefined;

    backend = await startTestBackend({
      features: [
        fleetPlugin,
        databaseProbe(c => {
          captured = c;
        }),
      ],
    });

    if (!captured) {
      throw new Error('plugin did not initialise a database');
    }
    client = captured;
  });

  afterAll(async () => {
    await backend?.stop();
  });

  afterEach(async () => {
    await client('sync_state').delete();
  });

  it('creates the sync_state table', async () => {
    await expect(client.schema.hasTable('sync_state')).resolves.toBe(true);
  });

  it('creates every sync_state column the ingestion layer relies on', async () => {
    const columns = await client('sync_state').columnInfo();

    expect(Object.keys(columns).sort()).toEqual([
      'consecutive_failures',
      'cursor',
      'last_attempt_at',
      'last_error',
      'last_success_at',
      'resource',
    ]);
  });

  it('defaults consecutive_failures to zero so backoff starts clean', async () => {
    await client('sync_state').insert({ resource: 'repositories' });

    const row = await client('sync_state')
      .where({ resource: 'repositories' })
      .first();

    expect(Number(row.consecutive_failures)).toBe(0);
    expect(row.cursor).toBeNull();
  });

  it('treats resource as a primary key so syncers cannot double-register', async () => {
    await client('sync_state').insert({ resource: 'pull_requests' });

    await expect(
      client('sync_state').insert({ resource: 'pull_requests' }),
    ).rejects.toThrow();
  });
});
