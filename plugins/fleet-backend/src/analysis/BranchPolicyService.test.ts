import { mockServices } from '@backstage/backend-test-utils';
import type {
  BitbucketCommit,
  BitbucketPullRequest,
  BitbucketRepository,
} from '../bitbucket/types';
import { CommitStore } from '../database/CommitStore';
import { PullRequestStore } from '../database/PullRequestStore';
import { RepositoryStore } from '../database/RepositoryStore';
import { SyncStateStore } from '../database/SyncStateStore';
import {
  startFleetTestDatabase,
  type FleetTestDatabase,
} from '../__testUtils__/database';
import { BranchPolicyService } from './BranchPolicyService';

const NOW = new Date('2026-08-26T12:00:00.000Z');
const DAY = 86_400_000;

function repository(
  slug: string,
  // Not an optional parameter with a default: passing `undefined` to one of
  // those uses the default, so `repository(slug, undefined)` was silently
  // getting 'main' and the no-branch case was never exercised.
  options: { noDefaultBranch?: boolean } = {},
): BitbucketRepository {
  return {
    workspace: 'demandai',
    slug,
    name: slug,
    url: `https://bitbucket.org/demandai/${slug}`,
    isPrivate: true,
    createdAt: '2024-01-01T10:00:00.000Z',
    updatedAt: '2026-08-19T12:00:00.000Z',
    ...(options.noDefaultBranch ? {} : { defaultBranch: 'main' }),
  } as BitbucketRepository;
}

/** A commit with explicit parents. `age` is days before NOW. */
function commit(
  hash: string,
  parents: string[],
  age = 1,
): BitbucketCommit & { parents: string[] } {
  return {
    hash,
    committedAt: new Date(NOW.getTime() - age * DAY).toISOString(),
    authorEmail: 'someone@demandai.co',
    parentCount: parents.length,
    parents,
  };
}

function mergedPr(
  id: number,
  mergeCommitHash: string | undefined,
  destinationBranch = 'main',
): BitbucketPullRequest {
  return {
    id,
    state: 'MERGED',
    createdAt: new Date(NOW.getTime() - 3 * DAY).toISOString(),
    updatedAt: new Date(NOW.getTime() - 2 * DAY).toISOString(),
    closedAt: new Date(NOW.getTime() - 2 * DAY).toISOString(),
    commentCount: 0,
    approvalCount: 1,
    participantCount: 1,
    destinationBranch,
    ...(mergeCommitHash ? { mergeCommitHash } : {}),
  };
}

describe('BranchPolicyService', () => {
  let db: FleetTestDatabase;
  let repositories: RepositoryStore;
  let commits: CommitStore;
  let pullRequests: PullRequestStore;
  let syncState: SyncStateStore;

  const build = () =>
    new BranchPolicyService({
      repositories,
      commits,
      pullRequests,
      syncState,
      logger: mockServices.logger.mock(),
    });

  async function seed(
    repo: BitbucketRepository,
    rows: Array<BitbucketCommit & { parents?: string[] }>,
    prs: BitbucketPullRequest[] = [],
  ) {
    await repositories.syncWorkspace('demandai', [repo], NOW);
    const stored = await repositories.findByEntityRef(
      `component:default/${repo.slug}`,
    );
    if (rows.length) await commits.insertMany(stored!.id, rows);
    if (prs.length) await pullRequests.upsertMany(stored!.id, prs);
    return stored!.id;
  }

  async function arrivals(id: number) {
    const rows = await db
      .client('commit')
      .where({ repository_id: id })
      .select('hash', 'arrival', 'on_mainline');
    return new Map<
      string,
      { arrival: string | null; onMainline: boolean | null }
    >(
      rows.map((row: any) => [
        row.hash,
        {
          arrival: row.arrival,
          // The test backend's driver returns booleans as 0/1 where production
          // Postgres returns real booleans; null still has to survive as null,
          // because "not classified" is a distinct state from "off mainline".
          onMainline:
            row.on_mainline === null ? null : Boolean(row.on_mainline),
        },
      ]),
    );
  }

  beforeAll(async () => {
    db = await startFleetTestDatabase();
    repositories = new RepositoryStore(db.client);
    commits = new CommitStore(db.client);
    pullRequests = new PullRequestStore(db.client);
    syncState = new SyncStateStore(db.client);
  });

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    await db.client('commit').delete();
    await db.client('pull_request').delete();
    await db.client('repository').delete();
    await db.client('sync_state').delete();
  });

  it('records how each commit reached the branch', async () => {
    const id = await seed(
      repository('crm'),
      [
        commit('merge', ['base', 'feature']),
        commit('feature', ['base'], 2),
        commit('base', [], 3),
      ],
      [mergedPr(1, 'merge')],
    );

    const summary = await build().classifyAll('demandai', NOW);
    const got = await arrivals(id);

    expect(summary.classified).toBe(3);
    expect(got.get('merge')).toEqual({
      arrival: 'pull-request',
      onMainline: true,
    });
    expect(got.get('feature')).toEqual({
      arrival: 'merged-in',
      onMainline: false,
    });
    expect(got.get('base')).toEqual({ arrival: 'direct', onMainline: true });
  });

  it('skips a repository with merged pull requests but no merge hashes', async () => {
    // The production bug this guard exists for: the first live pass ran with no
    // merge hashes stored and wrote 1,031 direct commits and ZERO via pull
    // request. Matching against an empty hash list does not fail -- it reports
    // every commit as direct, which is plausible enough to ship.
    const id = await seed(
      repository('oxp-backend'),
      [commit('a', ['b']), commit('b', [], 2)],
      [mergedPr(1, undefined)],
    );

    const summary = await build().classifyAll('demandai', NOW);
    const got = await arrivals(id);

    expect(summary.skippedNoMergeHashes).toBe(1);
    expect(summary.classified).toBe(0);
    expect([...got.values()].every(v => v.arrival === null)).toBe(true);
  });

  it('still measures a repository that genuinely has no pull requests', async () => {
    // Not the same case: with no pull requests at all, everything really did
    // land directly, and refusing to say so would hide the worst offenders --
    // 8 repositories here have nothing on mainline via a pull request.
    const id = await seed(repository('dai-redis'), [
      commit('a', ['b']),
      commit('b', [], 2),
    ]);

    const summary = await build().classifyAll('demandai', NOW);
    const got = await arrivals(id);

    expect(summary.skippedNoMergeHashes).toBe(0);
    expect(summary.classified).toBe(2);
    expect([...got.values()].every(v => v.arrival === 'direct')).toBe(true);
  });

  it('skips a repository whose commits are missing parent hashes', async () => {
    // Partial parent data is worse than none: the walk stops at the first gap
    // and reports a mainline far shorter than the truth.
    const withoutParents = {
      ...commit('b', [], 2),
      parents: undefined,
      parentCount: 1,
    } as unknown as BitbucketCommit;
    const id = await seed(repository('portal-ui'), [
      commit('a', ['b']),
      withoutParents,
    ]);

    const summary = await build().classifyAll('demandai', NOW);
    const got = await arrivals(id);

    expect(summary.skippedNoParents).toBe(1);
    expect(summary.classified).toBe(0);
    expect([...got.values()].every(v => v.arrival === null)).toBe(true);
  });

  it('does not let a root commit block its repository indefinitely', async () => {
    // A root commit legitimately has no parents and is stored with none, so the
    // missing-parents guard keys on parent_count rather than on null. 103 of
    // this estate's commits are roots.
    const id = await seed(repository('chat-widget'), [
      commit('a', ['root']),
      commit('root', [], 2),
    ]);

    const summary = await build().classifyAll('demandai', NOW);

    expect(summary.skippedNoParents).toBe(0);
    expect(summary.classified).toBe(2);
    expect((await arrivals(id)).get('root')?.arrival).toBe('direct');
  });

  it('skips a repository with no default branch recorded', async () => {
    await seed(repository('ux-designs', { noDefaultBranch: true }), [
      commit('a', ['b']),
    ]);

    const summary = await build().classifyAll('demandai', NOW);

    expect(summary.skippedNoBranch).toBe(1);
    expect(summary.classified).toBe(0);
  });

  it('ignores pull requests merged into another branch', async () => {
    // 13 repositories here send their pull requests to `develop`. One of those
    // does not authorise a commit landing on main.
    const id = await seed(
      repository('oxp-frontend'),
      [commit('a', ['b']), commit('b', [], 2)],
      [mergedPr(1, 'a', 'develop'), mergedPr(2, 'zzz', 'main')],
    );

    const summary = await build().classifyAll('demandai', NOW);

    expect(summary.classified).toBe(2);
    expect((await arrivals(id)).get('a')?.arrival).toBe('direct');
  });

  it('matches an abbreviated merge hash against the full SHA', async () => {
    // Bitbucket returns merge_commit.hash abbreviated to 12 characters.
    const full = 'a1b2c3d4e5f60123456789abcdef0123456789ab';
    const id = await seed(
      repository('dxp-mono'),
      [commit(full, ['base']), commit('base', [], 2)],
      [mergedPr(1, 'a1b2c3d4e5f6')],
    );

    await build().classifyAll('demandai', NOW);

    expect((await arrivals(id)).get(full)?.arrival).toBe('pull-request');
  });

  it('records success in sync_state so the pass is observable', async () => {
    await seed(repository('crm'), [commit('a', [])]);

    await build().classifyAll('demandai', NOW);
    const state = await syncState.get(
      BranchPolicyService.resourceKey('demandai'),
    );

    expect(new Date(state!.last_success_at!).toISOString()).toBe(
      NOW.toISOString(),
    );
    expect(Number(state?.consecutive_failures)).toBe(0);
  });

  it('names its sync_state resource per workspace', () => {
    expect(BranchPolicyService.resourceKey('demandai')).toBe(
      'branch-policy:demandai',
    );
  });

  it('keeps going when one repository fails, and does not record success', async () => {
    await repositories.syncWorkspace(
      'demandai',
      [repository('bad'), repository('good')],
      NOW,
    );
    for (const slug of ['bad', 'good']) {
      const stored = await repositories.findByEntityRef(
        `component:default/${slug}`,
      );
      await commits.insertMany(stored!.id, [
        commit(`${slug}-a`, [`${slug}-b`]),
        commit(`${slug}-b`, [], 2),
      ]);
    }
    jest.spyOn(commits, 'graph').mockImplementationOnce(async () => {
      throw new Error('graph unavailable');
    });

    const summary = await build().classifyAll('demandai', NOW);
    const state = await syncState.get(
      BranchPolicyService.resourceKey('demandai'),
    );

    expect(summary.repositories).toBe(2);
    expect(summary.failures).toBe(1);
    // The other repository still got classified.
    expect(summary.classified).toBe(2);
    expect(state?.last_success_at).toBeNull();
  });

  it('reports zero for a workspace with no repositories', async () => {
    const summary = await build().classifyAll('demandai', NOW);

    expect(summary).toEqual({
      repositories: 0,
      classified: 0,
      skippedNoParents: 0,
      skippedNoBranch: 0,
      skippedNoMergeHashes: 0,
      failures: 0,
    });
  });
});
