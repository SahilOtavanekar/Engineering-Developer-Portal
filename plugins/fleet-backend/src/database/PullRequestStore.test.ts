import type {
  BitbucketPullRequest,
  BitbucketRepository,
} from '../bitbucket/types';
import {
  startFleetTestDatabase,
  type FleetTestDatabase,
} from '../__testUtils__/database';
import { PullRequestStore } from './PullRequestStore';
import { RepositoryStore } from './RepositoryStore';

const NOW = new Date('2026-08-25T12:00:00.000Z');
const SINCE = new Date('2026-05-27T12:00:00.000Z');
const HOUR = 3_600_000;

function repository(): BitbucketRepository {
  return {
    workspace: 'demandai',
    slug: 'oxp-backend',
    name: 'oxp-backend',
    url: 'https://bitbucket.org/demandai/oxp-backend',
    isPrivate: true,
    createdAt: '2023-05-01T10:00:00.000Z',
    updatedAt: '2026-08-19T12:00:00.000Z',
  };
}

let seq = 0;

/** A merged pull request, opened `openHours` before NOW. */
function pr(
  overrides: Partial<BitbucketPullRequest> & { openHours?: number } = {},
): BitbucketPullRequest {
  const { openHours = 24, ...rest } = overrides;
  const createdAt = new Date(NOW.getTime() - openHours * HOUR);
  return {
    id: ++seq,
    state: 'MERGED',
    createdAt: createdAt.toISOString(),
    updatedAt: NOW.toISOString(),
    commentCount: 0,
    approvalCount: 0,
    participantCount: 0,
    ...rest,
  };
}

/** `hours` after the pull request opened. */
function after(base: BitbucketPullRequest, hours: number): string {
  return new Date(
    new Date(base.createdAt).getTime() + hours * HOUR,
  ).toISOString();
}

describe('PullRequestStore.reviewSummary', () => {
  let db: FleetTestDatabase;
  let pullRequests: PullRequestStore;
  let repositories: RepositoryStore;
  let repositoryId: number;

  beforeAll(async () => {
    db = await startFleetTestDatabase();
    pullRequests = new PullRequestStore(db.client);
    repositories = new RepositoryStore(db.client);
  });

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    seq = 0;
    await db.client('pull_request').delete();
    await db.client('repository').delete();
    await repositories.syncWorkspace('demandai', [repository()], NOW);
    const stored = await repositories.findByEntityRef(
      'component:default/oxp-backend',
    );
    repositoryId = stored!.id;
  });

  it('measures review time from opening to the first approval', async () => {
    const one = pr({ approvalCount: 1 });
    await pullRequests.upsertMany(repositoryId, [
      { ...one, firstApprovalAt: after(one, 4), closedAt: after(one, 6) },
    ]);

    const summary = await pullRequests.reviewSummary(repositoryId, SINCE);

    expect(summary.medianReviewHours).toBe(4);
    expect(summary.medianMergeHours).toBe(6);
  });

  it('reports review time and merge duration as different measurements', async () => {
    // The point of the requirement: waiting to be unblocked is not the same as
    // waiting to land.
    const one = pr({ approvalCount: 1 });
    await pullRequests.upsertMany(repositoryId, [
      { ...one, firstApprovalAt: after(one, 1), closedAt: after(one, 20) },
    ]);

    const summary = await pullRequests.reviewSummary(repositoryId, SINCE);

    expect(summary.medianReviewHours).toBe(1);
    expect(summary.medianMergeHours).toBe(20);
  });

  it('excludes unapproved pull requests from review time rather than scoring them zero', async () => {
    // Counting a review that never happened as instant would report a
    // flatteringly fast review time for a repository nobody reviews.
    const approved = pr({ approvalCount: 1 });
    const unapproved = pr();
    await pullRequests.upsertMany(repositoryId, [
      { ...approved, firstApprovalAt: after(approved, 10) },
      { ...unapproved, closedAt: after(unapproved, 1) },
    ]);

    const summary = await pullRequests.reviewSummary(repositoryId, SINCE);

    expect(summary.medianReviewHours).toBe(10);
    expect(summary.merged).toBe(2);
    expect(summary.approved).toBe(1);
  });

  it('leaves review time unset when nothing was approved', async () => {
    await pullRequests.upsertMany(repositoryId, [pr()]);

    const summary = await pullRequests.reviewSummary(repositoryId, SINCE);

    expect(summary.medianReviewHours).toBeUndefined();
    expect(summary.merged).toBe(1);
  });

  it('measures merge duration from the close time, not the last edit', async () => {
    // oxp-backend#98 was merged 38 seconds after opening but last updated four
    // minutes after. Using updated_at overstated it roughly sevenfold.
    const one = pr({ openHours: 1 });
    await pullRequests.upsertMany(repositoryId, [
      { ...one, closedAt: after(one, 0.01), updatedAt: after(one, 0.07) },
    ]);

    const summary = await pullRequests.reviewSummary(repositoryId, SINCE);

    expect(summary.medianMergeHours).toBe(0);
  });

  it('falls back to the last edit for rows stored before the close time existed', async () => {
    // Better an overstated duration than dropping historic pull requests out
    // of the median entirely.
    const one = pr({ openHours: 5 });
    await pullRequests.upsertMany(repositoryId, [one]);
    await db.client('pull_request').update({ closed_at: null });

    const summary = await pullRequests.reviewSummary(repositoryId, SINCE);

    expect(summary.medianMergeHours).toBe(5);
  });

  it('takes the median, so one slow review does not set the number', async () => {
    const prs = [1, 2, 3, 4, 100].map(hours => {
      const one = pr({ approvalCount: 1 });
      return { ...one, firstApprovalAt: after(one, hours) };
    });
    await pullRequests.upsertMany(repositoryId, prs);

    const summary = await pullRequests.reviewSummary(repositoryId, SINCE);

    expect(summary.medianReviewHours).toBe(3);
  });

  it('ignores an approval recorded before the pull request opened', async () => {
    // Clock skew between Bitbucket and a reviewer's client would otherwise
    // produce a negative review time.
    const one = pr({ approvalCount: 1 });
    await pullRequests.upsertMany(repositoryId, [
      { ...one, firstApprovalAt: after(one, -3) },
    ]);

    const summary = await pullRequests.reviewSummary(repositoryId, SINCE);

    expect(summary.medianReviewHours).toBeUndefined();
  });

  it('counts open pull requests separately from the window', async () => {
    await pullRequests.upsertMany(repositoryId, [
      pr({ state: 'OPEN' }),
      pr({ approvalCount: 1 }),
    ]);

    const summary = await pullRequests.reviewSummary(repositoryId, SINCE);

    expect(summary).toMatchObject({ merged: 1, open: 1 });
  });

  it('fills in both timestamps when an open pull request later merges', async () => {
    // The upsert must refresh them, or a pull request first seen open would
    // never acquire either.
    const open = pr({ state: 'OPEN' });
    await pullRequests.upsertMany(repositoryId, [open]);

    await pullRequests.upsertMany(repositoryId, [
      {
        ...open,
        state: 'MERGED',
        approvalCount: 1,
        firstApprovalAt: after(open, 2),
        closedAt: after(open, 3),
      },
    ]);

    const summary = await pullRequests.reviewSummary(repositoryId, SINCE);

    expect(summary).toMatchObject({
      merged: 1,
      open: 0,
      medianReviewHours: 2,
      medianMergeHours: 3,
    });
  });

  it('reports nothing for a repository with no pull requests', async () => {
    const summary = await pullRequests.reviewSummary(repositoryId, SINCE);

    expect(summary).toEqual({
      merged: 0,
      approved: 0,
      open: 0,
      medianMergeHours: undefined,
      medianReviewHours: undefined,
    });
  });
});
