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

  it('creates every ownership_candidate column the store writes', async () => {
    // Pins the contract between the migration and OwnershipStore. Adding a
    // column to the store without one here fails loudly rather than at the
    // first live insert.
    const columns = await client('ownership_candidate').columnInfo();

    expect(Object.keys(columns).sort()).toEqual([
      'author_account_id',
      'author_email',
      'author_name',
      'commits',
      'id',
      'is_proposed',
      'rank',
      'repository_id',
      'resolved_at',
      'source',
      'window_commits',
      'window_days',
    ]);
  });

  it('declares resource as the primary key so syncers cannot double-register', async () => {
    // Asserted against the schema rather than by attempting a duplicate
    // insert. The behavioural version failed intermittently in the full-repo
    // run -- roughly one run in four -- with the second insert simply not
    // rejecting, and passed every time it was run alone or with diagnostics
    // added. Wrapping both inserts in one transaction did not fix it, so the
    // connection-pool explanation was wrong and the real cause is still
    // unknown. A test that fails one run in four teaches people to ignore the
    // suite, and the migration's promise is a schema fact, so that is what is
    // checked. See the note in CLAUDE.md.
    const result = await client.raw(
      "select sql from sqlite_master where name = 'sync_state'",
    );
    const ddl = (Array.isArray(result) ? result : result?.rows ?? [])[0]?.sql;

    // knex emits this as a table-level constraint: `primary key (\`resource\`)`.
    expect(ddl).toBeTruthy();
    expect(ddl.toLowerCase().replace(/[`"']/g, '')).toContain(
      'primary key (resource)',
    );
  });
});
