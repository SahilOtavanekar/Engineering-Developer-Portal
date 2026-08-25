import { mockServices } from '@backstage/backend-test-utils';
import type { BitbucketCommit, BitbucketRepository } from '../bitbucket/types';
import { CommitStore } from '../database/CommitStore';
import { OwnershipStore } from '../database/OwnershipStore';
import { RepositoryStore } from '../database/RepositoryStore';
import { SyncStateStore } from '../database/SyncStateStore';
import {
  startFleetTestDatabase,
  type FleetTestDatabase,
} from '../__testUtils__/database';
import { CommitHistoryOwnershipResolver } from './CommitHistoryOwnershipResolver';
import { OwnershipService } from './OwnershipService';
import type { OwnershipResolver } from './types';

const NOW = new Date('2026-08-24T12:00:00.000Z');
const DAY = 86_400_000;

function repository(slug: string): BitbucketRepository {
  return {
    workspace: 'demandai',
    slug,
    name: slug,
    url: `https://bitbucket.org/demandai/${slug}`,
    isPrivate: true,
    createdAt: '2023-05-01T10:00:00.000Z',
    updatedAt: '2026-08-19T12:00:00.000Z',
  };
}

function commitsBy(email: string, n: number, offset = 0): BitbucketCommit[] {
  return Array.from({ length: n }, (_, i) => ({
    hash: `${email}-${offset + i}`,
    committedAt: new Date(NOW.getTime() - (offset + i) * DAY).toISOString(),
    authorName: email.split('@')[0],
    authorEmail: email,
    parentCount: 1,
  }));
}

describe('OwnershipService', () => {
  let db: FleetTestDatabase;
  let repositories: RepositoryStore;
  let commits: CommitStore;
  let ownership: OwnershipStore;
  let syncState: SyncStateStore;

  const build = (resolver?: OwnershipResolver) =>
    new OwnershipService({
      resolver: resolver ?? new CommitHistoryOwnershipResolver({ commits }),
      repositories,
      ownership,
      syncState,
      logger: mockServices.logger.mock(),
    });

  beforeAll(async () => {
    db = await startFleetTestDatabase();
    repositories = new RepositoryStore(db.client);
    commits = new CommitStore(db.client);
    ownership = new OwnershipStore(db.client);
    syncState = new SyncStateStore(db.client);
  });

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await db.client('ownership_candidate').delete();
    await db.client('commit').delete();
    await db.client('repository').delete();
    await db.client('sync_state').delete();
  });

  async function seed(slug: string) {
    await repositories.syncWorkspace('demandai', [repository(slug)], NOW);
    const stored = await repositories.findByEntityRef(
      `component:default/${slug}`,
    );
    return stored!.id;
  }

  it('separates a clear owner from a contested one and a silent one', async () => {
    const owned = await seed('owned');
    const contested = await seed('contested');
    await seed('silent');
    await repositories.syncWorkspace(
      'demandai',
      [repository('owned'), repository('contested'), repository('silent')],
      NOW,
    );
    await commits.insertMany(owned, commitsBy('ada@demandai.co', 20));
    await commits.insertMany(contested, [
      ...commitsBy('ada@demandai.co', 10),
      ...commitsBy('alan@demandai.co', 10, 20),
    ]);

    const summary = await build().resolveAll('demandai', NOW);

    expect(summary).toMatchObject({
      repositories: 3,
      proposed: 1,
      contested: 1,
      silent: 1,
      failures: 0,
    });
  });

  it('stores the candidates with the evidence behind them', async () => {
    const id = await seed('owned');
    await commits.insertMany(id, [
      ...commitsBy('ada@demandai.co', 20),
      ...commitsBy('alan@demandai.co', 5, 30),
    ]);

    await build().resolveAll('demandai', NOW);

    const stored = await ownership.forRepository(id);
    expect(stored).toHaveLength(2);
    expect(stored[0]).toMatchObject({
      rank: 1,
      isProposed: true,
      email: 'ada@demandai.co',
      commits: 20,
      windowCommits: 25,
      windowDays: 90,
      source: 'commit-history',
    });
    expect(stored[1]).toMatchObject({ rank: 2, isProposed: false });
  });

  it('marks nobody as proposed when there is no clear owner', async () => {
    const id = await seed('contested');
    await commits.insertMany(id, [
      ...commitsBy('ada@demandai.co', 10),
      ...commitsBy('alan@demandai.co', 10, 20),
    ]);

    await build().resolveAll('demandai', NOW);

    const stored = await ownership.forRepository(id);
    expect(stored).toHaveLength(2);
    expect(stored.some(c => c.isProposed)).toBe(false);
  });

  it('replaces the previous conclusion rather than accumulating', async () => {
    const id = await seed('owned');
    await commits.insertMany(id, commitsBy('ada@demandai.co', 20));
    await build().resolveAll('demandai', NOW);

    // Ada leaves, Alan takes over.
    await db.client('commit').delete();
    await commits.insertMany(id, commitsBy('alan@demandai.co', 20));
    await build().resolveAll('demandai', NOW);

    const stored = await ownership.forRepository(id);
    expect(stored).toHaveLength(1);
    expect(stored[0].email).toBe('alan@demandai.co');
  });

  it('carries on when one repository fails', async () => {
    const good = await seed('good');
    await repositories.syncWorkspace(
      'demandai',
      [repository('good'), repository('bad')],
      NOW,
    );
    await commits.insertMany(good, commitsBy('ada@demandai.co', 20));

    let calls = 0;
    const flaky: OwnershipResolver = {
      source: 'flaky',
      resolve: async (repositoryId, since, windowDays) => {
        if (++calls === 1) throw new Error('boom');
        return new CommitHistoryOwnershipResolver({ commits }).resolve(
          repositoryId,
          since,
          windowDays,
        );
      },
    };

    const summary = await build(flaky).resolveAll('demandai', NOW);

    expect(summary.failures).toBe(1);
    expect(summary.repositories).toBe(2);
  });

  it('records a partial failure rather than claiming success', async () => {
    await seed('bad');
    const broken: OwnershipResolver = {
      source: 'broken',
      resolve: async () => {
        throw new Error('boom');
      },
    };

    await build(broken).resolveAll('demandai', NOW);

    const state = await syncState.get(OwnershipService.resourceKey('demandai'));
    expect(state?.last_success_at).toBeNull();
    expect(Number(state?.consecutive_failures)).toBe(1);
  });

  it('records the resolver that produced the conclusion', async () => {
    const id = await seed('owned');
    await commits.insertMany(id, commitsBy('ada@demandai.co', 20));
    const named: OwnershipResolver = {
      source: 'entra-id',
      resolve: (repositoryId, since) =>
        new CommitHistoryOwnershipResolver({ commits }).resolve(
          repositoryId,
          since,
          90,
        ),
    };

    await build(named).resolveAll('demandai', NOW);

    const stored = await ownership.forRepository(id);
    expect(stored[0].source).toBe('entra-id');
  });

  describe('workspace-scoped reads for the catalog', () => {
    it('returns only confident proposals, keyed by slug', async () => {
      const owned = await seed('owned');
      await repositories.syncWorkspace(
        'demandai',
        [repository('owned'), repository('contested')],
        NOW,
      );
      const contested = await repositories.findByEntityRef(
        'component:default/contested',
      );
      await commits.insertMany(owned, commitsBy('ada@demandai.co', 20));
      await commits.insertMany(contested!.id, [
        ...commitsBy('ada@demandai.co', 10),
        ...commitsBy('alan@demandai.co', 10, 20),
      ]);
      await build().resolveAll('demandai', NOW);

      const proposed = await ownership.proposedForWorkspace('demandai');

      expect([...proposed.keys()]).toEqual(['owned']);
      expect(proposed.get('owned')).toMatchObject({
        email: 'ada@demandai.co',
        commits: 20,
        isProposed: true,
      });
    });

    it('does not leak another workspace in', async () => {
      const mine = await seed('mine');
      await commits.insertMany(mine, commitsBy('ada@demandai.co', 20));
      await build().resolveAll('demandai', NOW);

      await expect(
        ownership.proposedForWorkspace('someone-else'),
      ).resolves.toEqual(new Map());
    });

    it('lists every candidate author once, busiest first', async () => {
      const a = await seed('a');
      await repositories.syncWorkspace(
        'demandai',
        [repository('a'), repository('b')],
        NOW,
      );
      const b = await repositories.findByEntityRef('component:default/b');
      await commits.insertMany(a, [
        ...commitsBy('ada@demandai.co', 20),
        ...commitsBy('alan@demandai.co', 5, 30),
      ]);
      // Ada appears on both repositories and must still be listed once.
      await commits.insertMany(b!.id, commitsBy('ada@demandai.co', 30));
      await build().resolveAll('demandai', NOW);

      const authors = await ownership.candidateAuthors('demandai');

      expect(authors.map(x => x.email)).toEqual([
        'ada@demandai.co',
        'alan@demandai.co',
      ]);
    });

    it('excludes a repository that is no longer live', async () => {
      const id = await seed('gone');
      await commits.insertMany(id, commitsBy('ada@demandai.co', 20));
      await build().resolveAll('demandai', NOW);
      // The repository disappears upstream.
      await repositories.syncWorkspace('demandai', [], NOW);

      await expect(ownership.proposedForWorkspace('demandai')).resolves.toEqual(
        new Map(),
      );
      await expect(ownership.candidateAuthors('demandai')).resolves.toEqual([]);
    });
  });

  it('names its sync_state resource per workspace', () => {
    expect(OwnershipService.resourceKey('demandai')).toBe('ownership:demandai');
  });

  it('costs no Bitbucket requests', async () => {
    // The whole point of it being its own task: it reads stored commits only.
    const id = await seed('owned');
    await commits.insertMany(id, commitsBy('ada@demandai.co', 20));

    const summary = await build().resolveAll('demandai', NOW);

    expect(summary).not.toHaveProperty('requests');
  });
});
