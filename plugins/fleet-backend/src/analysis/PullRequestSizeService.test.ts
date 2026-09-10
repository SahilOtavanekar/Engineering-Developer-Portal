import { mockServices } from '@backstage/backend-test-utils';
import type {
  BitbucketPullRequest,
  BitbucketRepository,
} from '../bitbucket/types';
import { FakeBitbucketClient } from '../bitbucket/FakeBitbucketClient';
import { PullRequestStore } from '../database/PullRequestStore';
import { RepositoryStore } from '../database/RepositoryStore';
import { SyncStateStore } from '../database/SyncStateStore';
import {
  startFleetTestDatabase,
  type FleetTestDatabase,
} from '../__testUtils__/database';
import { PullRequestSizeService } from './PullRequestSizeService';

const NOW = new Date('2026-09-09T12:00:00.000Z');
const SINCE = new Date('2026-06-11T12:00:00.000Z');

function repository(slug: string): BitbucketRepository {
  return {
    workspace: 'demandai',
    slug,
    name: slug,
    url: `https://bitbucket.org/demandai/${slug}`,
    isPrivate: true,
    createdAt: '2023-05-01T10:00:00.000Z',
    updatedAt: NOW.toISOString(),
  };
}

let seq = 0;
function pr(overrides: Partial<BitbucketPullRequest> = {}) {
  return {
    id: ++seq,
    state: 'MERGED',
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    commentCount: 0,
    approvalCount: 0,
    participantCount: 0,
    ...overrides,
  } as BitbucketPullRequest;
}

describe('PullRequestSizeService', () => {
  let db: FleetTestDatabase;
  let pullRequests: PullRequestStore;
  let repositories: RepositoryStore;
  let syncState: SyncStateStore;
  let client: FakeBitbucketClient;

  const build = (options: { requestBudget?: number } = {}) =>
    new PullRequestSizeService({
      client,
      pullRequests,
      syncState,
      logger: mockServices.logger.mock(),
      ...options,
    });

  beforeAll(async () => {
    db = await startFleetTestDatabase();
    pullRequests = new PullRequestStore(db.client);
    repositories = new RepositoryStore(db.client);
    syncState = new SyncStateStore(db.client);
  });

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    seq = 0;
    await db.client('pull_request').delete();
    await db.client('repository').delete();
    await db.client('sync_state').delete();
    client = new FakeBitbucketClient();
  });

  async function seed(slug: string, prs: BitbucketPullRequest[]) {
    await repositories.syncWorkspace('demandai', [repository(slug)], NOW);
    const stored = await repositories.findByEntityRef(
      `component:default/${slug}`,
    );
    await pullRequests.upsertMany(stored!.id, prs);
    return stored!.id;
  }

  it('measures a merged pull request and stores the totals', async () => {
    const id = await seed('alpha', [pr()]);
    client.setPullRequestDiffstat('demandai', 'alpha', 1, [
      {
        path: 'src/a.ts',
        linesAdded: 30,
        linesRemoved: 12,
        status: 'modified',
      },
      { path: 'src/b.ts', linesAdded: 8, linesRemoved: 0, status: 'added' },
    ]);

    const summary = await build().measure('demandai', NOW);

    expect(summary).toMatchObject({ measured: 1, failures: 0, remaining: 0 });
    await expect(pullRequests.sizeSummary(id, SINCE)).resolves.toMatchObject({
      measured: 1,
      pending: 0,
      averageChangedLines: 50,
      largestChangedLines: 50,
    });
  });

  it('excludes generated files before storing', async () => {
    const id = await seed('alpha', [pr()]);
    client.setPullRequestDiffstat('demandai', 'alpha', 1, [
      { path: 'src/a.ts', linesAdded: 10, linesRemoved: 0, status: 'modified' },
      {
        path: 'package-lock.json',
        linesAdded: 6813,
        linesRemoved: 0,
        status: 'modified',
      },
    ]);

    await build().measure('demandai', NOW);

    await expect(pullRequests.sizeSummary(id, SINCE)).resolves.toMatchObject({
      averageChangedLines: 10,
    });
  });

  /**
   * `oxp-backend#112` is merged and has an empty diffstat. Storing zeroes is
   * what stops it being refetched on every sweep for ever -- the column is
   * nullable precisely so "never fetched" and "changed nothing" stay distinct.
   */
  it('stores an empty diffstat rather than leaving it to be retried', async () => {
    await seed('alpha', [pr()]);

    const first = await build().measure('demandai', NOW);
    expect(first.measured).toBe(1);

    const second = await build().measure('demandai', NOW);
    expect(second.measured).toBe(0);
    expect(second.requests).toBe(0);
  });

  it('never refetches a pull request it has already measured', async () => {
    await seed('alpha', [pr(), pr()]);
    await build().measure('demandai', NOW);
    const spentFirst = client.requestsFor('listPullRequestDiffstat');

    await build().measure('demandai', NOW);

    expect(spentFirst).toBe(2);
    expect(client.requestsFor('listPullRequestDiffstat')).toBe(2);
  });

  it('spends no more than its request budget in one sweep', async () => {
    await seed('alpha', [pr(), pr(), pr(), pr(), pr()]);

    const summary = await build({ requestBudget: 2 }).measure('demandai', NOW);

    expect(summary.requests).toBe(2);
    expect(summary.measured).toBe(2);
    // Reported rather than left implicit, so the log says whether the sweep
    // finished the estate or has more to do.
    expect(summary.remaining).toBe(3);
  });

  it('finishes the rest on the next sweep', async () => {
    await seed('alpha', [pr(), pr(), pr()]);
    const service = build({ requestBudget: 2 });

    await service.measure('demandai', NOW);
    const second = await service.measure('demandai', NOW);

    expect(second.measured).toBe(1);
    expect(second.remaining).toBe(0);
  });

  it('ignores an open pull request, which can still change', async () => {
    await seed('alpha', [pr({ state: 'OPEN' })]);

    const summary = await build().measure('demandai', NOW);

    expect(summary.measured).toBe(0);
    expect(client.requestsFor('listPullRequestDiffstat')).toBe(0);
  });

  it('carries on when one pull request cannot be measured', async () => {
    await seed('alpha', [pr(), pr()]);
    const failing = new FakeBitbucketClient();
    let calls = 0;
    failing.listPullRequestDiffstat = async () => {
      calls++;
      if (calls === 1) throw new Error('Bitbucket said no');
      return [
        { path: 'src/a.ts', linesAdded: 5, linesRemoved: 0, status: 'added' },
      ];
    };
    client = failing;

    const summary = await build().measure('demandai', NOW);

    expect(summary.failures).toBe(1);
    expect(summary.measured).toBe(1);
    // The failure is left unmeasured, so the next sweep retries just that one.
    expect(summary.remaining).toBe(1);
  });

  it('records a partial failure rather than claiming success', async () => {
    await seed('alpha', [pr()]);
    client.listPullRequestDiffstat = async () => {
      throw new Error('nope');
    };

    await build().measure('demandai', NOW);
    const state = await syncState.get('pull-request-size:demandai');

    expect(state?.last_success_at).toBeFalsy();
    expect(state?.last_error).toContain('could not be measured');
  });

  /**
   * The first live sweep ran 390 sequential requests for over 16 minutes
   * against a 20-minute task timeout, and the original version collected every
   * result and wrote once at the close -- so a timeout threw away every request
   * it had already paid for. Progress is written in batches now, and this pins
   * that rows exist before the sweep returns.
   */
  it('writes progress as it goes, so a timeout keeps what it paid for', async () => {
    const id = await seed(
      'alpha',
      Array.from({ length: 30 }, () => pr()),
    );

    let seen = 0;
    const slow = new FakeBitbucketClient();
    slow.listPullRequestDiffstat = async () => {
      seen++;
      // Once past the batch size, earlier results must already be stored.
      if (seen === 28) {
        const partial = await pullRequests.sizeSummary(id, SINCE);
        expect(partial.measured).toBeGreaterThanOrEqual(25);
      }
      return [
        { path: 'src/a.ts', linesAdded: 3, linesRemoved: 1, status: 'added' },
      ];
    };
    client = slow;

    const summary = await build().measure('demandai', NOW);

    expect(summary.measured).toBe(30);
  });

  it('names its sync_state resource per workspace', () => {
    expect(PullRequestSizeService.resourceKey('demandai')).toBe(
      'pull-request-size:demandai',
    );
  });
});
