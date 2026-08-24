import { mockServices } from '@backstage/backend-test-utils';
import { FakeBitbucketClient } from '../bitbucket/FakeBitbucketClient';
import type { BitbucketClient, BitbucketRepository } from '../bitbucket/types';
import { PullRequestStore } from '../database/PullRequestStore';
import { RepositoryStore } from '../database/RepositoryStore';
import { SyncStateStore } from '../database/SyncStateStore';
import { stubBitbucketClient } from '../__testUtils__/bitbucket';
import {
  startFleetTestDatabase,
  type FleetTestDatabase,
} from '../__testUtils__/database';
import { PullRequestIngestionService } from './PullRequestIngestionService';

const NOW = new Date('2026-08-21T12:00:00.000Z');
const LATER = new Date('2026-08-21T18:00:00.000Z');
const WINDOW_START = new Date('2026-05-23T12:00:00.000Z');

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

describe('PullRequestIngestionService', () => {
  let db: FleetTestDatabase;
  let repositories: RepositoryStore;
  let pullRequests: PullRequestStore;
  let syncState: SyncStateStore;

  const build = (client: BitbucketClient) =>
    new PullRequestIngestionService({
      client,
      repositories,
      pullRequests,
      syncState,
      logger: mockServices.logger.mock(),
    });

  beforeAll(async () => {
    db = await startFleetTestDatabase();
    repositories = new RepositoryStore(db.client);
    pullRequests = new PullRequestStore(db.client);
    syncState = new SyncStateStore(db.client);
  });

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await db.client('pull_request').delete();
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

  const clientWith = (approved: number, unreviewed: number) =>
    new FakeBitbucketClient([repository('alpha')]).withPullRequests(
      'demandai',
      'alpha',
      FakeBitbucketClient.generatePullRequests(approved, unreviewed, NOW),
    );

  it('stores pull requests for every live repository', async () => {
    await seed('alpha');

    const summary = await build(clientWith(6, 4)).ingest('demandai', NOW);

    expect(summary).toMatchObject({
      repositories: 1,
      pullRequestsWritten: 10,
      failures: 0,
    });
  });

  it('separates approved merges from self-merges', async () => {
    const id = await seed('alpha');

    await build(clientWith(6, 4)).ingest('demandai', NOW);

    await expect(
      pullRequests.reviewSummary(id, WINDOW_START),
    ).resolves.toMatchObject({ merged: 10, approved: 6 });
  });

  it('is incremental: a second pass fetches nothing new', async () => {
    await seed('alpha');
    const service = build(clientWith(3, 1));

    const first = await service.ingest('demandai', NOW);
    const second = await service.ingest('demandai', LATER);

    expect(first.pullRequestsWritten).toBe(4);
    expect(second.pullRequestsWritten).toBe(0);
  });

  it('cannot duplicate a pull request', async () => {
    const id = await seed('alpha');
    const service = build(clientWith(3, 1));

    await service.ingest('demandai', NOW);
    await service.ingest('demandai', LATER);

    await expect(pullRequests.count(id)).resolves.toBe(4);
  });

  it('refreshes an open pull request whose approvals changed', async () => {
    const id = await seed('alpha');
    const open = FakeBitbucketClient.generatePullRequests(0, 1, NOW, 'OPEN');

    await build(
      new FakeBitbucketClient([repository('alpha')]).withPullRequests(
        'demandai',
        'alpha',
        open,
      ),
    ).ingest('demandai', NOW);

    const approvedLater = [
      {
        ...open[0],
        approvalCount: 2,
        updatedAt: LATER.toISOString(),
      },
    ];
    await build(
      new FakeBitbucketClient([repository('alpha')]).withPullRequests(
        'demandai',
        'alpha',
        approvedLater,
      ),
    ).ingest('demandai', LATER);

    await expect(pullRequests.count(id)).resolves.toBe(1);
    const [row] = await db.client('pull_request').select('approval_count');
    expect(Number(row.approval_count)).toBe(2);
  });

  it('counts open pull requests separately from merged ones', async () => {
    const id = await seed('alpha');
    const mixed = [
      ...FakeBitbucketClient.generatePullRequests(2, 0, NOW, 'MERGED'),
      ...FakeBitbucketClient.generatePullRequests(0, 1, NOW, 'OPEN').map(
        pr => ({ ...pr, id: 99 }),
      ),
    ];

    await build(
      new FakeBitbucketClient([repository('alpha')]).withPullRequests(
        'demandai',
        'alpha',
        mixed,
      ),
    ).ingest('demandai', NOW);

    await expect(
      pullRequests.reviewSummary(id, WINDOW_START),
    ).resolves.toMatchObject({ merged: 2, approved: 2, open: 1 });
  });

  it('reports a median merge time', async () => {
    const id = await seed('alpha');

    await build(clientWith(3, 0)).ingest('demandai', NOW);
    const summary = await pullRequests.reviewSummary(id, WINDOW_START);

    // The generator opens each PR a day before its last update.
    expect(summary.medianMergeHours).toBeGreaterThan(0);
  });

  it('handles a repository that has never had a pull request', async () => {
    const id = await seed('alpha');

    const summary = await build(
      new FakeBitbucketClient([repository('alpha')]),
    ).ingest('demandai', NOW);

    expect(summary.pullRequestsWritten).toBe(0);
    await expect(
      pullRequests.reviewSummary(id, WINDOW_START),
    ).resolves.toMatchObject({ merged: 0, approved: 0, open: 0 });
  });

  it('carries on when one repository fails', async () => {
    await seed('alpha');
    await repositories.syncWorkspace(
      'demandai',
      [repository('alpha'), repository('beta')],
      NOW,
    );

    const flaky = stubBitbucketClient({
      listPullRequests: async (_w, slug) => {
        if (slug === 'alpha') throw new Error('unreachable');
        return FakeBitbucketClient.generatePullRequests(1, 0, NOW);
      },
    });

    const summary = await build(flaky).ingest('demandai', NOW);

    expect(summary.failures).toBe(1);
    expect(summary.pullRequestsWritten).toBe(1);
  });

  it('records a partial failure rather than claiming success', async () => {
    await seed('alpha');
    const failing = stubBitbucketClient({
      listPullRequests: async () => {
        throw new Error('boom');
      },
    });

    await build(failing).ingest('demandai', NOW);

    const state = await syncState.get('pull-requests:demandai');
    expect(Number(state!.consecutive_failures)).toBe(1);
  });

  it('names its sync_state resource per workspace', () => {
    expect(PullRequestIngestionService.resourceKey('demandai')).toBe(
      'pull-requests:demandai',
    );
  });
});
