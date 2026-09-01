import { mockServices } from '@backstage/backend-test-utils';
import {
  startFleetTestDatabase,
  type FleetTestDatabase,
} from '../__testUtils__/database';
import { BranchStore } from '../database/BranchStore';
import { PullRequestStore } from '../database/PullRequestStore';
import { RepositoryStore } from '../database/RepositoryStore';
import { SyncStateStore } from '../database/SyncStateStore';
import { FakeBitbucketClient } from '../bitbucket/FakeBitbucketClient';
import { BranchDivergenceService } from './BranchDivergenceService';
import type {
  BitbucketPullRequest,
  BitbucketRepository,
} from '../bitbucket/types';

const NOW = new Date('2026-09-01T12:00:00.000Z');

const repository = (): BitbucketRepository => ({
  workspace: 'demandai',
  slug: 'oxp-frontend',
  name: 'oxp-frontend',
  url: 'https://bitbucket.org/demandai/oxp-frontend',
  isPrivate: true,
  defaultBranch: 'main',
  createdAt: '2025-01-01T00:00:00.000Z',
  updatedAt: '2026-08-19T12:00:00.000Z',
});

const pullRequest = (
  id: number,
  sourceBranch: string,
  state: string,
): BitbucketPullRequest => ({
  id,
  title: `pr ${id}`,
  state,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-02T00:00:00.000Z',
  commentCount: 0,
  approvalCount: 0,
  participantCount: 0,
  sourceBranch,
  destinationBranch: 'main',
});

describe('BranchDivergenceService', () => {
  let db: FleetTestDatabase;
  let repositories: RepositoryStore;
  let branches: BranchStore;
  let pullRequests: PullRequestStore;
  let syncState: SyncStateStore;
  let client: FakeBitbucketClient;
  let repositoryId: number;

  beforeAll(async () => {
    db = await startFleetTestDatabase();
    repositories = new RepositoryStore(db.client);
    branches = new BranchStore(db.client);
    pullRequests = new PullRequestStore(db.client);
    syncState = new SyncStateStore(db.client);
  });

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await db.client('branch').delete();
    await db.client('pull_request').delete();
    await db.client('repository').delete();
    client = new FakeBitbucketClient();

    await repositories.syncWorkspace('demandai', [repository()], NOW);
    const stored = await repositories.findByEntityRef(
      'component:default/oxp-frontend',
    );
    repositoryId = stored!.id;
    await branches.replaceForRepository(
      repositoryId,
      [
        { name: 'main' },
        { name: 'feature-live', lastCommitHash: 'aaa' },
        { name: 'feature-merged', lastCommitHash: 'bbb' },
      ],
      'main',
    );
  });

  const service = (requestBudget?: number) =>
    new BranchDivergenceService({
      repositories,
      branches,
      syncState,
      client,
      logger: mockServices.logger.mock(),
      requestBudget,
    });

  it('measures a branch with no merged pull request', async () => {
    client.setDivergence('demandai', 'oxp-frontend', 'feature-live', {
      commits: 17,
      capped: false,
    });

    const summary = await service().measureAll('demandai');

    expect(summary.diverged).toBe(1);
    const stored = await branches.divergenceSummary(repositoryId);
    expect(stored).toMatchObject({ diverged: 1, commits: 17, capped: false });
  });

  it('skips a branch whose pull request was merged', async () => {
    // The squash trap: a squash merge leaves the branch's commits unreachable
    // from main for ever, so `commits?exclude=main` reports shipped work as
    // stranded. Two of eight branches sampled on the real oxp-frontend were
    // exactly this.
    await pullRequests.upsertMany(repositoryId, [
      pullRequest(1, 'feature-merged', 'MERGED'),
    ]);
    client.setDivergence('demandai', 'oxp-frontend', 'feature-merged', {
      commits: 120,
      capped: true,
    });
    client.setDivergence('demandai', 'oxp-frontend', 'feature-live', {
      commits: 3,
      capped: false,
    });

    const summary = await service().measureAll('demandai');

    expect(summary.measured).toBe(1);
    const stored = await branches.divergenceSummary(repositoryId);
    expect(stored.worst.map(b => b.name)).toEqual(['feature-live']);
  });

  it('still measures a branch whose pull request is open or declined', async () => {
    // Only a *merged* pull request means the work reached main.
    await pullRequests.upsertMany(repositoryId, [
      pullRequest(2, 'feature-live', 'OPEN'),
    ]);
    client.setDivergence('demandai', 'oxp-frontend', 'feature-live', {
      commits: 9,
      capped: false,
    });

    await service().measureAll('demandai');

    const stored = await branches.divergenceSummary(repositoryId);
    expect(stored.worst.map(b => b.name)).toEqual(['feature-live']);
  });

  it('never measures the default branch', async () => {
    await service().measureAll('demandai');

    const stored = await branches.divergenceSummary(repositoryId);
    expect(stored.worst.every(b => b.name !== 'main')).toBe(true);
  });

  it('stops at the request budget and says what it left', async () => {
    // The cap is what stops a workspace that grows a thousand branches from
    // turning a background pass into the dominant consumer of the quota.
    client.setDivergence('demandai', 'oxp-frontend', 'feature-live', {
      commits: 5,
      capped: false,
    });
    client.setDivergence('demandai', 'oxp-frontend', 'feature-merged', {
      commits: 5,
      capped: false,
    });

    const summary = await service(1).measureAll('demandai');

    expect(summary.measured).toBe(1);
    expect(summary.skippedOverBudget).toBe(1);
  });

  it('reports a capped count as a floor, not a total', async () => {
    client.setDivergence('demandai', 'oxp-frontend', 'feature-live', {
      commits: 100,
      capped: true,
    });

    await service().measureAll('demandai');

    const stored = await branches.divergenceSummary(repositoryId);
    expect(stored.capped).toBe(true);
  });

  it('keeps going when one branch cannot be measured', async () => {
    // A branch can be deleted between the listing and the measurement.
    jest
      .spyOn(client, 'countCommitsAhead')
      .mockRejectedValueOnce(new Error('branch not found'));

    const summary = await service().measureAll('demandai');

    expect(summary.failures).toBe(1);
    expect(summary.measured).toBe(1);
  });

  describe('surviving the branch ingestion pass', () => {
    // Branch ingestion replaces every row wholesale every 30 minutes, while
    // divergence is measured every 6 hours. Without carrying the measurement
    // across the replace, nothing would ever be readable.
    it('keeps a measurement when the branch has not moved', async () => {
      client.setDivergence('demandai', 'oxp-frontend', 'feature-live', {
        commits: 12,
        capped: false,
      });
      await service().measureAll('demandai');

      await branches.replaceForRepository(
        repositoryId,
        [
          { name: 'main' },
          { name: 'feature-live', lastCommitHash: 'aaa' },
          { name: 'feature-merged', lastCommitHash: 'bbb' },
        ],
        'main',
      );

      const stored = await branches.divergenceSummary(repositoryId);
      expect(stored.commits).toBe(12);
      expect(stored.worst.map(b => b.name)).toEqual(['feature-live']);
    });

    it('drops a measurement when the branch has moved', async () => {
      // New commits landed, so the stored figure is stale. Showing it as
      // current would be worse than showing nothing.
      client.setDivergence('demandai', 'oxp-frontend', 'feature-live', {
        commits: 12,
        capped: false,
      });
      await service().measureAll('demandai');

      await branches.replaceForRepository(
        repositoryId,
        [
          { name: 'main' },
          { name: 'feature-live', lastCommitHash: 'ccc' },
          { name: 'feature-merged', lastCommitHash: 'bbb' },
        ],
        'main',
      );

      // The moved branch's figure is gone; the untouched one survives, which
      // is why this asserts on the branch rather than on the total.
      const stored = await branches.divergenceSummary(repositoryId);
      expect(stored.worst).toEqual([]);
      expect(stored.commits).toBe(0);
    });
  });

  it('reports nothing measured as unknown, not as clean', async () => {
    const stored = await branches.divergenceSummary(repositoryId);

    expect(stored.measured).toBe(0);
    expect(stored.diverged).toBe(0);
  });
});
