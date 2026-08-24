import { mockServices } from '@backstage/backend-test-utils';
import { FakeBitbucketClient } from '../bitbucket/FakeBitbucketClient';
import type { BitbucketClient } from '../bitbucket/types';
import { RepositoryStore } from '../database/RepositoryStore';
import { SyncStateStore } from '../database/SyncStateStore';
import {
  startFleetTestDatabase,
  type FleetTestDatabase,
} from '../__testUtils__/database';
import { stubBitbucketClient } from '../__testUtils__/bitbucket';
import { RepositoryIngestionService } from './RepositoryIngestionService';

const T1 = new Date('2026-08-21T09:00:00.000Z');
const T2 = new Date('2026-08-21T10:00:00.000Z');

describe('RepositoryIngestionService', () => {
  let db: FleetTestDatabase;
  let repositories: RepositoryStore;
  let syncState: SyncStateStore;

  const build = (client: BitbucketClient) =>
    new RepositoryIngestionService({
      client,
      repositories,
      syncState,
      logger: mockServices.logger.mock(),
    });

  beforeAll(async () => {
    db = await startFleetTestDatabase();
    repositories = new RepositoryStore(db.client);
    syncState = new SyncStateStore(db.client);
  });

  afterAll(async () => {
    await db?.stop();
  });

  afterEach(async () => {
    await db.client('repository').delete();
    await db.client('sync_state').delete();
  });

  it('persists what the client returns', async () => {
    const client = FakeBitbucketClient.withGeneratedRepositories(
      'demandai',
      95,
    );

    const summary = await build(client).ingest('demandai', T1);

    expect(summary).toMatchObject({ inserted: 95, updated: 0, removed: 0 });
    await expect(repositories.count('demandai')).resolves.toEqual({
      live: 95,
      removed: 0,
    });
  });

  it('records success in sync_state with a cursor', async () => {
    const client = FakeBitbucketClient.withGeneratedRepositories('demandai', 3);

    await build(client).ingest('demandai', T1);

    const state = await syncState.get('repositories:demandai');
    expect(state!.cursor).toBe(T1.toISOString());
    expect(new Date(state!.last_success_at!).toISOString()).toBe(
      T1.toISOString(),
    );
    expect(Number(state!.consecutive_failures)).toBe(0);
  });

  it('can be re-run without duplicating anything', async () => {
    const client = FakeBitbucketClient.withGeneratedRepositories(
      'demandai',
      10,
    );
    const service = build(client);

    await service.ingest('demandai', T1);
    const second = await service.ingest('demandai', T2);

    expect(second).toMatchObject({ inserted: 0, updated: 10, removed: 0 });
    await expect(repositories.count('demandai')).resolves.toEqual({
      live: 10,
      removed: 0,
    });
  });

  it('records the failure and rethrows so the caller can decide', async () => {
    const failing = stubBitbucketClient({
      listRepositories: async () => {
        throw new Error('bitbucket is down');
      },
    });

    await expect(build(failing).ingest('demandai', T1)).rejects.toThrow(
      'bitbucket is down',
    );

    const state = await syncState.get('repositories:demandai');
    expect(Number(state!.consecutive_failures)).toBe(1);
    expect(state!.last_error).toBe('bitbucket is down');
  });

  it('leaves previously stored repositories intact when a later run fails', async () => {
    const good = FakeBitbucketClient.withGeneratedRepositories('demandai', 5);
    await build(good).ingest('demandai', T1);

    const failing = stubBitbucketClient({
      listRepositories: async () => {
        throw new Error('bitbucket is down');
      },
    });
    await expect(build(failing).ingest('demandai', T2)).rejects.toThrow();

    await expect(repositories.count('demandai')).resolves.toEqual({
      live: 5,
      removed: 0,
    });
  });

  it('names its sync_state resource per workspace', () => {
    expect(RepositoryIngestionService.resourceKey('demandai')).toBe(
      'repositories:demandai',
    );
  });
});
