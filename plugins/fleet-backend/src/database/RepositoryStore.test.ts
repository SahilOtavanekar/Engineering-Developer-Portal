import type { BitbucketRepository } from '../bitbucket/types';
import {
  startFleetTestDatabase,
  type FleetTestDatabase,
} from '../__testUtils__/database';
import { RepositoryStore } from './RepositoryStore';

function repository(
  overrides: Partial<BitbucketRepository> = {},
): BitbucketRepository {
  return {
    workspace: 'demandai',
    slug: 'oxp-backend',
    name: 'OXP Backend',
    url: 'https://bitbucket.org/demandai/oxp-backend',
    isPrivate: true,
    projectKey: 'DDS',
    defaultBranch: 'main',
    language: 'java',
    sizeBytes: 2_685_588,
    createdAt: '2023-05-01T10:00:00.000Z',
    updatedAt: '2026-08-19T12:00:00.000Z',
    ...overrides,
  };
}

const T1 = new Date('2026-08-21T09:00:00.000Z');
const T2 = new Date('2026-08-21T10:00:00.000Z');
const T3 = new Date('2026-08-21T11:00:00.000Z');

describe('RepositoryStore', () => {
  let db: FleetTestDatabase;
  let store: RepositoryStore;

  beforeAll(async () => {
    db = await startFleetTestDatabase();
    store = new RepositoryStore(db.client);
  });

  afterAll(async () => {
    await db?.stop();
  });

  afterEach(async () => {
    await db.client('repository').delete();
  });

  describe('syncWorkspace', () => {
    it('stores a repository with the catalog join key', async () => {
      await store.syncWorkspace('demandai', [repository()], T1);

      const stored = await store.findByEntityRef(
        'component:default/oxp-backend',
      );

      expect(stored).toMatchObject({
        workspace: 'demandai',
        slug: 'oxp-backend',
        name: 'OXP Backend',
        project_key: 'DDS',
        default_branch: 'main',
        language: 'java',
        size_bytes: 2_685_588,
        is_private: true,
        is_live: true,
      });
    });

    it('is idempotent: running three times leaves one row', async () => {
      const repos = [repository({ slug: 'a' }), repository({ slug: 'b' })];

      await store.syncWorkspace('demandai', repos, T1);
      await store.syncWorkspace('demandai', repos, T2);
      const third = await store.syncWorkspace('demandai', repos, T3);

      await expect(store.count('demandai')).resolves.toEqual({
        live: 2,
        removed: 0,
      });
      expect(third).toEqual({
        inserted: 0,
        updated: 2,
        removed: 0,
        live: 2,
      });
    });

    it('reports inserts and updates separately', async () => {
      const first = await store.syncWorkspace(
        'demandai',
        [repository({ slug: 'a' })],
        T1,
      );
      const second = await store.syncWorkspace(
        'demandai',
        [repository({ slug: 'a' }), repository({ slug: 'b' })],
        T2,
      );

      expect(first).toMatchObject({ inserted: 1, updated: 0 });
      expect(second).toMatchObject({ inserted: 1, updated: 1 });
    });

    it('refreshes mutable fields on re-sync', async () => {
      await store.syncWorkspace('demandai', [repository()], T1);
      await store.syncWorkspace(
        'demandai',
        [repository({ name: 'Renamed', language: 'typescript' })],
        T2,
      );

      const stored = await store.findByEntityRef(
        'component:default/oxp-backend',
      );

      expect(stored?.name).toBe('Renamed');
      expect(stored?.language).toBe('typescript');
    });

    it('preserves first_seen_at across re-syncs but moves last_synced_at', async () => {
      await store.syncWorkspace('demandai', [repository()], T1);
      await store.syncWorkspace('demandai', [repository()], T2);

      const stored = await store.findByEntityRef(
        'component:default/oxp-backend',
      );

      expect(new Date(stored!.first_seen_at).toISOString()).toBe(
        T1.toISOString(),
      );
      expect(new Date(stored!.last_synced_at).toISOString()).toBe(
        T2.toISOString(),
      );
    });

    it('stores absent optional fields as null, not empty strings', async () => {
      await store.syncWorkspace(
        'demandai',
        [
          repository({
            description: undefined,
            language: undefined,
            projectKey: undefined,
            sizeBytes: undefined,
          }),
        ],
        T1,
      );

      const stored = await store.findByEntityRef(
        'component:default/oxp-backend',
      );

      expect(stored?.description).toBeNull();
      expect(stored?.language).toBeNull();
      expect(stored?.project_key).toBeNull();
      expect(stored?.size_bytes).toBeNull();
    });
  });

  describe('repositories that disappear from Bitbucket', () => {
    it('marks them removed rather than deleting the row', async () => {
      await store.syncWorkspace(
        'demandai',
        [repository({ slug: 'a' }), repository({ slug: 'b' })],
        T1,
      );

      const summary = await store.syncWorkspace(
        'demandai',
        [repository({ slug: 'a' })],
        T2,
      );

      expect(summary.removed).toBe(1);
      await expect(store.count('demandai')).resolves.toEqual({
        live: 1,
        removed: 1,
      });
    });

    it('keeps them out of listLive', async () => {
      await store.syncWorkspace(
        'demandai',
        [repository({ slug: 'a' }), repository({ slug: 'b' })],
        T1,
      );
      await store.syncWorkspace('demandai', [repository({ slug: 'a' })], T2);

      const live = await store.listLive('demandai');

      expect(live.map(r => r.slug)).toEqual(['a']);
    });

    it('revives one that comes back', async () => {
      await store.syncWorkspace('demandai', [repository({ slug: 'a' })], T1);
      await store.syncWorkspace('demandai', [], T2);
      await store.syncWorkspace('demandai', [repository({ slug: 'a' })], T3);

      const stored = await store.findByEntityRef('component:default/a');

      expect(stored?.is_live).toBe(true);
      expect(stored?.removed_at).toBeNull();
      // Still the original sighting, not the revival.
      expect(new Date(stored!.first_seen_at).toISOString()).toBe(
        T1.toISOString(),
      );
    });

    it('marks everything removed when the workspace comes back empty', async () => {
      await store.syncWorkspace(
        'demandai',
        [repository({ slug: 'a' }), repository({ slug: 'b' })],
        T1,
      );

      const summary = await store.syncWorkspace('demandai', [], T2);

      expect(summary.removed).toBe(2);
      await expect(store.listLive('demandai')).resolves.toEqual([]);
    });
  });

  describe('workspace isolation', () => {
    it('does not mark another workspace’s repositories as removed', async () => {
      await store.syncWorkspace('demandai', [repository({ slug: 'a' })], T1);
      await store.syncWorkspace(
        'other',
        [repository({ workspace: 'other', slug: 'b' })],
        T1,
      );

      await store.syncWorkspace('other', [], T2);

      await expect(store.count('demandai')).resolves.toEqual({
        live: 1,
        removed: 0,
      });
    });
  });
});
