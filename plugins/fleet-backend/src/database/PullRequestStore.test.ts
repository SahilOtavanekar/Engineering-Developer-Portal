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

  describe('sizeSummary', () => {
    /** Stores a diffstat directly, as the size pass would. */
    async function sized(
      rows: Array<{
        linesAdded: number;
        linesRemoved?: number;
        filesChanged?: number;
        filesAdded?: number;
      }>,
    ) {
      const prs = rows.map(() => pr());
      await pullRequests.upsertMany(repositoryId, prs);
      const stored = (await db
        .client('pull_request')
        .where({ repository_id: repositoryId })
        .orderBy('pr_id', 'asc')
        .select('id', 'pr_id')) as Array<{ id: number; pr_id: number }>;

      await pullRequests.recordSizes(
        rows.map((row, i) => ({
          id: stored[i].id,
          filesChanged: row.filesChanged ?? 1,
          filesAdded: row.filesAdded ?? 0,
          linesAdded: row.linesAdded,
          linesRemoved: row.linesRemoved ?? 0,
          excludedLines: 0,
        })),
      );
    }

    it('reports nothing measurable for a repository with no pull requests', async () => {
      await expect(
        pullRequests.sizeSummary(repositoryId, SINCE),
      ).resolves.toMatchObject({ measured: 0, pending: 0, imports: 0 });
    });

    /**
     * The portal's gap, not the repository's: merged pull requests exist but
     * nothing has fetched their diffstat. Scoring these as small would hand
     * out full marks for work nothing has looked at.
     */
    it('separates unfetched pull requests from measured ones', async () => {
      await pullRequests.upsertMany(repositoryId, [pr(), pr()]);
      await sized([{ linesAdded: 10 }]);

      const summary = await pullRequests.sizeSummary(repositoryId, SINCE);

      expect(summary.measured).toBe(1);
      expect(summary.pending).toBe(2);
    });

    it('reports the mean, the median and the largest', async () => {
      // A 10,000-line import beside three small changes: exactly the shape
      // that makes the mean useless and the median honest.
      await sized([
        { linesAdded: 10 },
        { linesAdded: 20 },
        { linesAdded: 30 },
        { linesAdded: 10_000 },
      ]);

      const summary = await pullRequests.sizeSummary(repositoryId, SINCE);

      expect(summary.averageChangedLines).toBe(2515);
      expect(summary.medianChangedLines).toBe(30);
      expect(summary.largestChangedLines).toBe(10_000);
    });

    it('adds removals to additions, because both are reviewed', async () => {
      await sized([{ linesAdded: 40, linesRemoved: 60 }]);

      await expect(
        pullRequests.sizeSummary(repositoryId, SINCE),
      ).resolves.toMatchObject({ averageChangedLines: 100 });
    });

    /**
     * `dai-delivery#1` added 157 of 158 files and `daarwyn-bo-ui#1` 40 of 41.
     * Requiring every file to be new would miss both for the sake of one
     * touched `.gitignore`.
     */
    it('counts a pull request of almost entirely new files as an import', async () => {
      await sized([
        { linesAdded: 30_000, filesChanged: 158, filesAdded: 157 },
        { linesAdded: 50, filesChanged: 4, filesAdded: 0 },
      ]);

      await expect(
        pullRequests.sizeSummary(repositoryId, SINCE),
      ).resolves.toMatchObject({ imports: 1 });
    });

    it('does not call a small pull request an import, however new its files', async () => {
      // Two new files is a normal change. "Almost entirely new files" says
      // nothing useful below a handful.
      await sized([{ linesAdded: 20, filesChanged: 2, filesAdded: 2 }]);

      await expect(
        pullRequests.sizeSummary(repositoryId, SINCE),
      ).resolves.toMatchObject({ imports: 0 });
    });

    it('treats a genuinely empty diffstat as measured, not as pending', async () => {
      // `oxp-backend#112` is merged and changed nothing.
      await sized([{ linesAdded: 0, filesChanged: 0 }]);

      await expect(
        pullRequests.sizeSummary(repositoryId, SINCE),
      ).resolves.toMatchObject({
        measured: 1,
        pending: 0,
        averageChangedLines: 0,
      });
    });
  });

  describe('peer approval', () => {
    /**
     * The distinction the review metric rests on. Measured over the 365 pull
     * requests merged in 90 days on this estate, 265 carried an approval and
     * only **85** carried one from anybody other than the author -- so
     * counting approvals rather than peer approvals measures the button being
     * pressed, not a second person having looked. It is also what explains the
     * 12-second median time to first approval recorded in CLAUDE.md.
     */
    it('does not count the author approving their own pull request', async () => {
      const own = pr({ approvalCount: 1, authorAccountId: 'ada' });
      await pullRequests.upsertMany(repositoryId, [
        {
          ...own,
          participants: [
            { accountId: 'ada', role: 'PARTICIPANT', approved: true },
          ],
        },
      ]);

      const summary = await pullRequests.reviewSummary(repositoryId, SINCE);

      expect(summary.approved).toBe(1);
      expect(summary.peerApproved).toBe(0);
    });

    it('counts an approval from anybody else', async () => {
      const reviewed = pr({ approvalCount: 1, authorAccountId: 'ada' });
      await pullRequests.upsertMany(repositoryId, [
        {
          ...reviewed,
          participants: [
            { accountId: 'grace', role: 'REVIEWER', approved: true },
          ],
        },
      ]);

      const summary = await pullRequests.reviewSummary(repositoryId, SINCE);

      expect(summary.peerApproved).toBe(1);
    });

    it('counts a pull request once however many people approved it', async () => {
      const reviewed = pr({ approvalCount: 2, authorAccountId: 'ada' });
      await pullRequests.upsertMany(repositoryId, [
        {
          ...reviewed,
          participants: [
            { accountId: 'grace', role: 'REVIEWER', approved: true },
            { accountId: 'alan', role: 'REVIEWER', approved: true },
          ],
        },
      ]);

      const summary = await pullRequests.reviewSummary(repositoryId, SINCE);

      expect(summary.peerApproved).toBe(1);
    });

    it('counts a peer approval even when the author also approved', async () => {
      const both = pr({ approvalCount: 2, authorAccountId: 'ada' });
      await pullRequests.upsertMany(repositoryId, [
        {
          ...both,
          participants: [
            { accountId: 'ada', role: 'PARTICIPANT', approved: true },
            { accountId: 'grace', role: 'REVIEWER', approved: true },
          ],
        },
      ]);

      const summary = await pullRequests.reviewSummary(repositoryId, SINCE);

      expect(summary.peerApproved).toBe(1);
    });

    it('ignores a participant who turned up but did not approve', async () => {
      const unapproved = pr({ authorAccountId: 'ada' });
      await pullRequests.upsertMany(repositoryId, [
        {
          ...unapproved,
          participants: [
            { accountId: 'grace', role: 'REVIEWER', approved: false },
          ],
        },
      ]);

      const summary = await pullRequests.reviewSummary(repositoryId, SINCE);

      expect(summary.peerApproved).toBe(0);
    });

    /**
     * Conservative by design: an approval the portal cannot attribute is not
     * evidence that a second person looked. Costs nothing on this estate --
     * no row in either column is null -- but a future ingestion gap must not
     * silently manufacture peer reviews.
     */
    it('will not call an unattributable approval a peer review', async () => {
      const unknownApprover = pr({ approvalCount: 1, authorAccountId: 'ada' });
      const unknownAuthor = pr({ approvalCount: 1 });
      await pullRequests.upsertMany(repositoryId, [
        {
          ...unknownApprover,
          participants: [{ role: 'REVIEWER', approved: true }],
        },
        {
          ...unknownAuthor,
          participants: [
            { accountId: 'grace', role: 'REVIEWER', approved: true },
          ],
        },
      ]);

      const summary = await pullRequests.reviewSummary(repositoryId, SINCE);

      expect(summary.approved).toBe(2);
      expect(summary.peerApproved).toBe(0);
    });

    it('is zero for a repository whose merges nobody approved', async () => {
      await pullRequests.upsertMany(repositoryId, [
        { ...pr({ authorAccountId: 'ada' }), participants: [] },
      ]);

      const summary = await pullRequests.reviewSummary(repositoryId, SINCE);

      expect(summary.peerApproved).toBe(0);
    });
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

  // Exact equality is deliberate here, unlike the assertions above: the point
  // is that every count is a real zero and no median was invented. A new field
  // must be added to this list rather than the assertion being loosened.
  it('reports nothing for a repository with no pull requests', async () => {
    const summary = await pullRequests.reviewSummary(repositoryId, SINCE);

    expect(summary).toEqual({
      merged: 0,
      approved: 0,
      peerApproved: 0,
      open: 0,
      medianMergeHours: undefined,
      medianReviewHours: undefined,
    });
  });
});
