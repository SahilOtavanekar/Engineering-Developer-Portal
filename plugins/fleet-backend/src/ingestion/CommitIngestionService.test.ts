import { mockServices } from '@backstage/backend-test-utils';
import { FakeBitbucketClient } from '../bitbucket/FakeBitbucketClient';
import type { BitbucketClient, BitbucketRepository } from '../bitbucket/types';
import { CommitStore } from '../database/CommitStore';
import { RepositoryStore } from '../database/RepositoryStore';
import { SyncStateStore } from '../database/SyncStateStore';
import {
  startFleetTestDatabase,
  type FleetTestDatabase,
} from '../__testUtils__/database';
import { stubBitbucketClient } from '../__testUtils__/bitbucket';
import { CommitIngestionService } from './CommitIngestionService';

const NOW = new Date('2026-08-21T12:00:00.000Z');
const LATER = new Date('2026-08-21T18:00:00.000Z');

function repository(slug: string): BitbucketRepository {
  return {
    workspace: 'demandai',
    slug,
    name: slug,
    url: `https://bitbucket.org/demandai/${slug}`,
    isPrivate: true,
    defaultBranch: 'main',
    createdAt: '2023-05-01T10:00:00.000Z',
    updatedAt: '2026-08-19T12:00:00.000Z',
  };
}

describe('CommitIngestionService', () => {
  let db: FleetTestDatabase;
  let repositories: RepositoryStore;
  let commits: CommitStore;
  let syncState: SyncStateStore;

  const build = (client: BitbucketClient, windowDays?: number) =>
    new CommitIngestionService({
      client,
      repositories,
      commits,
      syncState,
      logger: mockServices.logger.mock(),
      windowDays,
    });

  beforeAll(async () => {
    db = await startFleetTestDatabase();
    repositories = new RepositoryStore(db.client);
    commits = new CommitStore(db.client);
    syncState = new SyncStateStore(db.client);
  });

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await db.client('commit').delete();
    await db.client('repository').delete();
    await db.client('sync_state').delete();
  });

  async function seedRepositories(...slugs: string[]) {
    await repositories.syncWorkspace('demandai', slugs.map(repository), NOW);
  }

  it('ingests commits for every live repository', async () => {
    await seedRepositories('alpha', 'beta');
    const client = new FakeBitbucketClient([
      repository('alpha'),
      repository('beta'),
    ])
      .withCommits(
        'demandai',
        'alpha',
        FakeBitbucketClient.generateCommits(5, NOW),
      )
      .withCommits(
        'demandai',
        'beta',
        FakeBitbucketClient.generateCommits(3, NOW),
      );

    const summary = await build(client).ingest('demandai', NOW);

    expect(summary).toMatchObject({
      repositories: 2,
      commitsWritten: 8,
      failures: 0,
    });
  });

  it('records the newest commit onto the repository row', async () => {
    await seedRepositories('alpha');
    const client = new FakeBitbucketClient([repository('alpha')]).withCommits(
      'demandai',
      'alpha',
      FakeBitbucketClient.generateCommits(4, NOW),
    );

    await build(client).ingest('demandai', NOW);

    const stored = await repositories.findByEntityRef(
      'component:default/alpha',
    );
    expect(new Date(stored!.last_commit_at!).toISOString()).toBe(
      NOW.toISOString(),
    );
  });

  it('is incremental: a second pass fetches only what is new', async () => {
    await seedRepositories('alpha');
    const client = new FakeBitbucketClient([repository('alpha')]).withCommits(
      'demandai',
      'alpha',
      FakeBitbucketClient.generateCommits(5, NOW),
    );
    const service = build(client);

    const first = await service.ingest('demandai', NOW);
    const second = await service.ingest('demandai', LATER);

    expect(first.commitsWritten).toBe(5);
    expect(second.commitsWritten).toBe(0);
  });

  it('re-running cannot duplicate commits', async () => {
    await seedRepositories('alpha');
    const client = new FakeBitbucketClient([repository('alpha')]).withCommits(
      'demandai',
      'alpha',
      FakeBitbucketClient.generateCommits(6, NOW),
    );
    const service = build(client);

    await service.ingest('demandai', NOW);
    await service.ingest('demandai', LATER);

    const stored = await repositories.findByEntityRef(
      'component:default/alpha',
    );
    await expect(commits.count(stored!.id)).resolves.toBe(6);
  });

  it('skips repositories that are no longer live', async () => {
    await seedRepositories('alpha', 'beta');
    await repositories.syncWorkspace('demandai', [repository('alpha')], LATER);

    const client = new FakeBitbucketClient([repository('alpha')]).withCommits(
      'demandai',
      'alpha',
      FakeBitbucketClient.generateCommits(2, NOW),
    );

    const summary = await build(client).ingest('demandai', LATER);

    expect(summary.repositories).toBe(1);
  });

  it('carries on when one repository fails', async () => {
    await seedRepositories('alpha', 'beta');
    const working = new FakeBitbucketClient([]).withCommits(
      'demandai',
      'beta',
      FakeBitbucketClient.generateCommits(3, NOW),
    );
    const flaky = stubBitbucketClient({
      listRepositories: (w: string) => working.listRepositories(w),
      listCommits: async (w, slug, options) => {
        if (slug === 'alpha') throw new Error('repository is unreachable');
        return working.listCommits(w, slug, options);
      },
    });

    const summary = await build(flaky).ingest('demandai', NOW);

    expect(summary.failures).toBe(1);
    expect(summary.commitsWritten).toBe(3);
  });

  it('records a partial failure in sync_state rather than claiming success', async () => {
    await seedRepositories('alpha');
    const failing = stubBitbucketClient({
      listCommits: async () => {
        throw new Error('boom');
      },
    });

    await build(failing).ingest('demandai', NOW);

    const state = await syncState.get('commits:demandai');
    expect(Number(state!.consecutive_failures)).toBe(1);
    expect(state!.last_success_at).toBeNull();
  });

  it('records success when everything worked', async () => {
    await seedRepositories('alpha');
    const client = new FakeBitbucketClient([repository('alpha')]).withCommits(
      'demandai',
      'alpha',
      FakeBitbucketClient.generateCommits(2, NOW),
    );

    await build(client).ingest('demandai', NOW);

    const state = await syncState.get('commits:demandai');
    expect(Number(state!.consecutive_failures)).toBe(0);
    expect(new Date(state!.last_success_at!).toISOString()).toBe(
      NOW.toISOString(),
    );
  });

  it('bounds the first pass to the configured window', async () => {
    await seedRepositories('alpha');
    const old = FakeBitbucketClient.generateCommits(
      3,
      new Date('2026-01-01T00:00:00.000Z'),
    );
    const recent = FakeBitbucketClient.generateCommits(2, NOW).map(c => ({
      ...c,
      hash: `recent-${c.hash}`,
    }));
    const client = new FakeBitbucketClient([repository('alpha')]).withCommits(
      'demandai',
      'alpha',
      [...recent, ...old],
    );

    const summary = await build(client, 30).ingest('demandai', NOW);

    expect(summary.commitsWritten).toBe(2);
  });

  it('names its sync_state resource per workspace', () => {
    expect(CommitIngestionService.resourceKey('demandai')).toBe(
      'commits:demandai',
    );
  });
});
