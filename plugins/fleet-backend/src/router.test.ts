import { mockCredentials, mockServices } from '@backstage/backend-test-utils';
import { AuthorizeResult } from '@backstage/plugin-permission-common';
import { ConfigReader } from '@backstage/config';
import {
  readIdentityRegister,
  type IdentityRegister,
} from './identity/identityRegister';
import express from 'express';
import request from 'supertest';
import type { BitbucketCommit, BitbucketRepository } from './bitbucket/types';
import { CommitStore } from './database/CommitStore';
import { BranchStore } from './database/BranchStore';
import { DeploymentStore } from './database/DeploymentStore';
import { PipelineStore } from './database/PipelineStore';
import { OwnershipStore } from './database/OwnershipStore';
import { PullRequestStore } from './database/PullRequestStore';
import { RepositoryStore } from './database/RepositoryStore';
import { ScoreStore } from './database/ScoreStore';
import {
  startFleetTestDatabase,
  type FleetTestDatabase,
} from './__testUtils__/database';
import { createRouter } from './router';

const NOW = new Date('2026-08-21T12:00:00.000Z');

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
    sizeBytes: 13_780_800,
    createdAt: '2023-05-01T10:00:00.000Z',
    updatedAt: '2026-08-19T12:00:00.000Z',
    ...overrides,
  };
}

function commit(overrides: Partial<BitbucketCommit> = {}): BitbucketCommit {
  return {
    hash: 'abc123',
    committedAt: '2026-08-20T09:00:00.000Z',
    authorEmail: 'ada@demandai.co',
    authorName: 'Ada Lovelace',
    parentCount: 1,
    ...overrides,
  };
}

describe('createRouter', () => {
  let db: FleetTestDatabase;
  let repositories: RepositoryStore;
  let commits: CommitStore;
  let branches: BranchStore;
  let pullRequests: PullRequestStore;
  let deployments: DeploymentStore;
  let pipelines: PipelineStore;
  let ownership: OwnershipStore;
  let scores: ScoreStore;

  async function app(
    result:
      | AuthorizeResult.ALLOW
      | AuthorizeResult.DENY = AuthorizeResult.ALLOW,
    identity?: IdentityRegister,
  ) {
    const router = await createRouter({
      identity,
      repositories,
      commits,
      branches,
      pullRequests,
      deployments,
      pipelines,
      ownership,
      scores,
      nominalWeight: 30,
      httpAuth: mockServices.httpAuth(),
      permissions: mockServices.permissions.mock({
        authorize: async () => [{ result }],
      }),
      logger: mockServices.logger.mock(),
    });
    return express().use(router);
  }

  beforeAll(async () => {
    db = await startFleetTestDatabase();
    repositories = new RepositoryStore(db.client);
    commits = new CommitStore(db.client);
    branches = new BranchStore(db.client);
    pullRequests = new PullRequestStore(db.client);
    deployments = new DeploymentStore(db.client);
    pipelines = new PipelineStore(db.client);
    ownership = new OwnershipStore(db.client);
    scores = new ScoreStore(db.client);
  });

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await db.client('repo_score').delete();
    await db.client('branch').delete();
    await db.client('pull_request').delete();
    await db.client('deployment').delete();
    await db.client('ownership_candidate').delete();
    await db.client('commit').delete();
    await db.client('repository').delete();
  });

  const url = '/repositories/by-entity/component/default/oxp-backend';

  it('returns 404 for a repository the portal has no facts about', async () => {
    await request(await app())
      .get(url)
      .expect(404);
  });

  it('serves the stored facts for a known repository', async () => {
    await repositories.syncWorkspace('demandai', [repository()], NOW);

    const res = await request(await app())
      .get(url)
      .expect(200);

    expect(res.body).toMatchObject({
      entityRef: 'component:default/oxp-backend',
      workspace: 'demandai',
      slug: 'oxp-backend',
      projectKey: 'DDS',
      defaultBranch: 'main',
      sizeBytes: 13_780_800,
      isPrivate: true,
    });
  });

  /** Two addresses for one human, plus an excluded bot. */
  const register = () =>
    readIdentityRegister(
      new ConfigReader({
        people: {
          ada: {
            name: 'Ada Lovelace',
            email: 'ada@demandai.co',
            aliases: ['ada.l@gmail.com'],
          },
        },
        notPeople: ['builder@bots.example.com'],
      }),
      mockServices.logger.mock(),
    );

  async function seedWithCommits(rows: Parameters<typeof commit>[0][]) {
    await repositories.syncWorkspace('demandai', [repository()], NOW);
    const stored = await repositories.findByEntityRef(
      'component:default/oxp-backend',
    );
    await commits.insertMany(
      stored!.id,
      rows.map(r => commit(r)),
    );
    return stored!;
  }

  describe('repository creator', () => {
    it('names the author of the earliest commit', async () => {
      // Bitbucket exposes no creator -- its repository `owner` is the
      // workspace -- so the first commit is the only available answer.
      await seedWithCommits([
        {
          hash: 'later',
          committedAt: '2026-08-20T10:00:00.000Z',
          authorEmail: 'alan@demandai.co',
        },
        {
          hash: 'first',
          committedAt: '2026-08-01T10:00:00.000Z',
          authorEmail: 'ada.l@gmail.com',
        },
      ]);

      const res = await request(await app(AuthorizeResult.ALLOW, register()))
        .get(url)
        .expect(200);

      // Resolved through the register: the alias reports the person, not the
      // address they happened to commit under.
      expect(res.body.createdBy).toMatchObject({
        name: 'Ada Lovelace',
        firstCommitAt: '2026-08-01T10:00:00.000Z',
        importedHistory: false,
        notAPerson: false,
      });
    });

    it('flags imported history rather than claiming a creator', async () => {
      // 5 of 96 repositories here have commits older than the repository. The
      // author of an imported commit may never have touched this repository.
      const stored = await seedWithCommits([
        {
          hash: 'ancient',
          committedAt: '2020-01-01T10:00:00.000Z',
          authorEmail: 'ada@demandai.co',
        },
      ]);
      expect(stored).toBeDefined();

      const res = await request(await app(AuthorizeResult.ALLOW, register()))
        .get(url)
        .expect(200);

      expect(res.body.createdBy.importedHistory).toBe(true);
    });

    it('is absent for a repository with no commits', async () => {
      await repositories.syncWorkspace('demandai', [repository()], NOW);

      const res = await request(await app())
        .get(url)
        .expect(200);

      expect(res.body.createdBy).toBeUndefined();
    });
  });

  describe('active contributors', () => {
    it('names them, resolved onto one person per human', async () => {
      await seedWithCommits([
        { hash: 'a', authorEmail: 'ada@demandai.co', authorName: 'Ada' },
        { hash: 'b', authorEmail: 'ada.l@gmail.com', authorName: 'A Lovelace' },
        { hash: 'c', authorEmail: 'alan@demandai.co', authorName: 'Alan T' },
      ]);

      const res = await request(await app(AuthorizeResult.ALLOW, register()))
        .get(url)
        .expect(200);

      // Two addresses, one human, two commits -- not two contributors of one.
      // Keyed by email, because the display name on a commit is unreliable:
      // the register is what decides who someone is.
      expect(res.body.contributors).toEqual([
        {
          name: 'Ada Lovelace',
          email: 'ada@demandai.co',
          commits: 2,
          unregistered: false,
        },
        {
          name: 'Alan T',
          email: 'alan@demandai.co',
          commits: 1,
          unregistered: true,
        },
      ]);
    });

    it('marks someone the register does not know rather than dropping them', async () => {
      await seedWithCommits([{ hash: 'a', authorEmail: 'ghost@demandai.co' }]);

      const res = await request(await app(AuthorizeResult.ALLOW, register()))
        .get(url)
        .expect(200);

      expect(res.body.contributors).toEqual([
        expect.objectContaining({
          email: 'ghost@demandai.co',
          unregistered: true,
        }),
      ]);
    });

    it('is empty for a dormant repository', async () => {
      // 48 of 96. Dormancy, reported elsewhere -- not an absence of people.
      await repositories.syncWorkspace('demandai', [repository()], NOW);

      const res = await request(await app())
        .get(url)
        .expect(200);

      expect(res.body.contributors).toEqual([]);
    });
  });

  it('summarises commit activity, excluding merges', async () => {
    await repositories.syncWorkspace('demandai', [repository()], NOW);
    const stored = await repositories.findByEntityRef(
      'component:default/oxp-backend',
    );
    await commits.insertMany(stored!.id, [
      commit({ hash: 'a', authorEmail: 'ada@demandai.co' }),
      commit({ hash: 'b', authorEmail: 'alan@demandai.co' }),
      commit({ hash: 'merge', parentCount: 2 }),
    ]);

    const res = await request(await app())
      .get(url)
      .expect(200);

    expect(res.body.activity).toEqual({
      windowDays: 90,
      commits: 2,
      authors: 2,
    });
    expect(res.body.lastCommitAt).toBe('2026-08-20T09:00:00.000Z');
  });

  it('reports zero activity for a dormant repository', async () => {
    await repositories.syncWorkspace('demandai', [repository()], NOW);

    const res = await request(await app())
      .get(url)
      .expect(200);

    expect(res.body.activity).toMatchObject({ commits: 0, authors: 0 });
    expect(res.body.lastCommitAt).toBeUndefined();
  });

  it('serialises timestamps as ISO strings across the HTTP boundary', async () => {
    await repositories.syncWorkspace('demandai', [repository()], NOW);

    const res = await request(await app())
      .get(url)
      .expect(200);

    expect(res.body.lastSyncedAt).toBe(NOW.toISOString());
    expect(res.body.createdAt).toBe('2023-05-01T10:00:00.000Z');
  });

  it('omits absent optional fields rather than sending nulls', async () => {
    await repositories.syncWorkspace(
      'demandai',
      [repository({ language: undefined, description: undefined })],
      NOW,
    );

    const res = await request(await app())
      .get(url)
      .expect(200);

    expect('language' in res.body).toBe(false);
    expect('description' in res.body).toBe(false);
  });

  it('refuses when the permission policy denies', async () => {
    await repositories.syncWorkspace('demandai', [repository()], NOW);

    await request(await app(AuthorizeResult.DENY))
      .get(url)
      .expect(403);
  });

  it('accepts a mixed-case entity ref', async () => {
    await repositories.syncWorkspace('demandai', [repository()], NOW);

    await request(await app())
      .get('/repositories/by-entity/Component/Default/oxp-backend')
      .expect(200);
  });

  it('omits the score until a scoring run has covered the repository', async () => {
    await repositories.syncWorkspace('demandai', [repository()], NOW);

    const res = await request(await app())
      .get(url)
      .expect(200);

    expect(res.body.score).toBeUndefined();
  });

  it('serves the latest score once one exists', async () => {
    await repositories.syncWorkspace('demandai', [repository()], NOW);
    const stored = await repositories.findByEntityRef(
      'component:default/oxp-backend',
    );

    await scores.record(
      stored!.id,
      {
        total: 55,
        band: 'needs-attention',
        availableWeight: 30,
        breakdown: [
          {
            id: 'active-commits',
            title: 'Active commits',
            weight: 20,
            points: 12,
            detail: '6 commits in 90 days',
            available: true,
          },
        ],
      },
      NOW,
    );

    const res = await request(await app())
      .get(url)
      .expect(200);

    expect(res.body.score).toMatchObject({
      total: 55,
      band: 'needs-attention',
      availableWeight: 30,
      nominalWeight: 30,
      computedAt: NOW.toISOString(),
    });
    expect(res.body.score.breakdown).toHaveLength(1);
  });

  it('returns score history oldest first, so a trend reads left to right', async () => {
    await repositories.syncWorkspace('demandai', [repository()], NOW);
    const stored = await repositories.findByEntityRef(
      'component:default/oxp-backend',
    );

    const runs = [
      { at: new Date('2026-08-19T12:00:00.000Z'), total: 40 },
      { at: new Date('2026-08-20T12:00:00.000Z'), total: 55 },
      { at: new Date('2026-08-21T12:00:00.000Z'), total: 70 },
    ];
    for (const run of runs) {
      await scores.record(
        stored!.id,
        {
          total: run.total,
          band: 'needs-attention',
          availableWeight: 85,
          breakdown: [],
        },
        run.at,
      );
    }

    const res = await request(await app())
      .get(url)
      .expect(200);

    expect(res.body.score.history.map((h: any) => h.total)).toEqual([
      40, 55, 70,
    ]);
    // The headline score stays the newest, not the first in the series.
    expect(res.body.score.total).toBe(70);
  });

  it('omits history for a repository scored only once', async () => {
    await repositories.syncWorkspace('demandai', [repository()], NOW);
    const stored = await repositories.findByEntityRef(
      'component:default/oxp-backend',
    );
    await scores.record(
      stored!.id,
      { total: 70, band: 'healthy', availableWeight: 85, breakdown: [] },
      NOW,
    );

    const res = await request(await app())
      .get(url)
      .expect(200);

    expect(res.body.score.history).toEqual([
      { total: 70, computedAt: NOW.toISOString() },
    ]);
  });

  it('serves pull request throughput alongside the facts', async () => {
    await repositories.syncWorkspace('demandai', [repository()], NOW);
    const stored = await repositories.findByEntityRef(
      'component:default/oxp-backend',
    );
    await pullRequests.upsertMany(stored!.id, [
      {
        id: 1,
        state: 'MERGED',
        createdAt: '2026-08-19T12:00:00.000Z',
        updatedAt: '2026-08-20T12:00:00.000Z',
        commentCount: 2,
        approvalCount: 1,
        participantCount: 1,
      },
      {
        id: 2,
        state: 'MERGED',
        createdAt: '2026-08-19T12:00:00.000Z',
        updatedAt: '2026-08-20T12:00:00.000Z',
        commentCount: 0,
        approvalCount: 0,
        participantCount: 0,
      },
    ]);

    const res = await request(await app())
      .get(url)
      .expect(200);

    expect(res.body.reviews).toMatchObject({ merged: 2, approved: 1, open: 0 });
    // 24 hours between opening and merging, which is what section 6 calls
    // average merge duration.
    expect(res.body.reviews.medianMergeHours).toBe(24);
  });

  it('serves branch health and names the abandoned branches', async () => {
    await repositories.syncWorkspace('demandai', [repository()], NOW);
    const stored = await repositories.findByEntityRef(
      'component:default/oxp-backend',
    );
    await branches.replaceForRepository(
      stored!.id,
      [
        { name: 'main', lastCommitAt: '2026-08-20T12:00:00.000Z' },
        { name: 'feature/old', lastCommitAt: '2025-01-01T00:00:00.000Z' },
        { name: 'feature/older', lastCommitAt: '2024-01-01T00:00:00.000Z' },
      ],
      'main',
    );

    const res = await request(await app())
      .get(url)
      .expect(200);

    expect(res.body.branches).toMatchObject({ total: 3, active: 1, stale: 2 });
    expect(res.body.branches.stalest.map((b: any) => b.name)).toEqual([
      'feature/older',
      'feature/old',
    ]);
  });

  it('reports empty branch and review data rather than omitting them', async () => {
    await repositories.syncWorkspace('demandai', [repository()], NOW);

    const res = await request(await app())
      .get(url)
      .expect(200);

    expect(res.body.branches).toEqual({
      total: 0,
      active: 0,
      stale: 0,
      stalest: [],
    });
    expect(res.body.reviews).toMatchObject({ merged: 0, approved: 0, open: 0 });
  });

  it('serves what is live in each environment, promotion order first', async () => {
    await repositories.syncWorkspace('demandai', [repository()], NOW);
    const stored = await repositories.findByEntityRef(
      'component:default/oxp-backend',
    );
    await deployments.replaceForRepository(stored!.id, [
      {
        uuid: '{p}',
        environmentName: 'production',
        environmentType: 'Production',
        state: 'COMPLETED',
        releaseName: '#412',
        commitHash: 'abc123',
        createdAt: '2026-08-20T09:00:00.000Z',
      },
      {
        uuid: '{s}',
        environmentName: 'staging',
        environmentType: 'Staging',
        state: 'COMPLETED',
        releaseName: '#413',
        commitHash: 'def456',
        createdAt: '2026-08-21T09:00:00.000Z',
      },
    ]);

    const res = await request(await app())
      .get(url)
      .expect(200);

    expect(res.body.environments).toEqual([
      {
        name: 'staging',
        type: 'Staging',
        releaseName: '#413',
        commitHash: 'def456',
        deployedAt: '2026-08-21T09:00:00.000Z',
      },
      {
        name: 'production',
        type: 'Production',
        releaseName: '#412',
        commitHash: 'abc123',
        deployedAt: '2026-08-20T09:00:00.000Z',
      },
    ]);
  });

  it('reports an empty environment list rather than omitting it', async () => {
    // A repository whose pipeline names do not match its configured
    // environments has no records. The field must still be present, or the
    // frontend cannot tell "nothing deployed" from "not loaded".
    await repositories.syncWorkspace('demandai', [repository()], NOW);

    const res = await request(await app())
      .get(url)
      .expect(200);

    expect(res.body.environments).toEqual([]);
  });

  describe('ownership proposal', () => {
    async function storeCandidates(
      candidates: Array<{
        rank: number;
        is_proposed: boolean;
        author_name: string;
        author_email: string;
        commits: number;
      }>,
    ) {
      await repositories.syncWorkspace('demandai', [repository()], NOW);
      const stored = await repositories.findByEntityRef(
        'component:default/oxp-backend',
      );
      await db.client('ownership_candidate').insert(
        candidates.map(candidate => ({
          repository_id: stored!.id,
          ...candidate,
          window_commits: 40,
          window_days: 90,
          source: 'commit-history',
          resolved_at: NOW,
        })),
      );
    }

    it('serves the proposed owner with the evidence behind it', async () => {
      await storeCandidates([
        {
          rank: 1,
          is_proposed: true,
          author_name: 'Ada Lovelace',
          author_email: 'ada@demandai.co',
          commits: 34,
        },
        {
          rank: 2,
          is_proposed: false,
          author_name: 'Alan Turing',
          author_email: 'alan@demandai.co',
          commits: 6,
        },
      ]);

      const res = await request(await app())
        .get(url)
        .expect(200);

      expect(res.body.ownershipProposal).toEqual({
        source: 'commit-history',
        proposed: {
          name: 'Ada Lovelace',
          email: 'ada@demandai.co',
          commits: 34,
        },
        candidates: [
          { name: 'Ada Lovelace', email: 'ada@demandai.co', commits: 34 },
          { name: 'Alan Turing', email: 'alan@demandai.co', commits: 6 },
        ],
        windowCommits: 40,
        windowDays: 90,
        resolvedAt: NOW.toISOString(),
      });
    });

    it('serves the candidates but no proposal when none was confident', async () => {
      await storeCandidates([
        {
          rank: 1,
          is_proposed: false,
          author_name: 'Ada Lovelace',
          author_email: 'ada@demandai.co',
          commits: 20,
        },
        {
          rank: 2,
          is_proposed: false,
          author_name: 'Alan Turing',
          author_email: 'alan@demandai.co',
          commits: 20,
        },
      ]);

      const res = await request(await app())
        .get(url)
        .expect(200);

      expect(res.body.ownershipProposal.proposed).toBeUndefined();
      expect(res.body.ownershipProposal.candidates).toHaveLength(2);
    });

    it('omits the proposal entirely before the first ownership pass', async () => {
      await repositories.syncWorkspace('demandai', [repository()], NOW);

      const res = await request(await app())
        .get(url)
        .expect(200);

      expect(res.body.ownershipProposal).toBeUndefined();
    });

    it('never claims the catalog owner has changed', async () => {
      // The proposal is advisory. Nothing here may write spec.owner, and the
      // payload must not carry anything that looks like it did.
      await storeCandidates([
        {
          rank: 1,
          is_proposed: true,
          author_name: 'Ada Lovelace',
          author_email: 'ada@demandai.co',
          commits: 34,
        },
      ]);

      const res = await request(await app())
        .get(url)
        .expect(200);

      expect(res.body).not.toHaveProperty('owner');
      expect(res.body.ownershipProposal.source).toBe('commit-history');
    });
  });

  it('serves review time and merge duration as separate numbers', async () => {
    await repositories.syncWorkspace('demandai', [repository()], NOW);
    const stored = await repositories.findByEntityRef(
      'component:default/oxp-backend',
    );
    const created = new Date(NOW.getTime() - 48 * 3_600_000);
    await pullRequests.upsertMany(stored!.id, [
      {
        id: 1,
        state: 'MERGED',
        createdAt: created.toISOString(),
        updatedAt: NOW.toISOString(),
        firstApprovalAt: new Date(
          created.getTime() + 2 * 3_600_000,
        ).toISOString(),
        closedAt: new Date(created.getTime() + 9 * 3_600_000).toISOString(),
        commentCount: 1,
        approvalCount: 1,
        participantCount: 2,
      },
    ]);

    const res = await request(await app())
      .get(url)
      .expect(200);

    expect(res.body.reviews).toMatchObject({
      merged: 1,
      approved: 1,
      medianReviewHours: 2,
      medianMergeHours: 9,
    });
  });

  it('serves lifetime facts alongside the activity window', async () => {
    // A repository whose only commits predate the window still has a life.
    await repositories.syncWorkspace('demandai', [repository()], NOW);
    const stored = await repositories.findByEntityRef(
      'component:default/oxp-backend',
    );
    await commits.insertMany(stored!.id, [
      commit({
        hash: 'ancient1',
        committedAt: '2025-08-18T10:00:00.000Z',
        authorEmail: 'ada@demandai.co',
      }),
      commit({
        hash: 'ancient2',
        committedAt: '2025-08-18T11:00:00.000Z',
        authorEmail: 'alan@demandai.co',
      }),
    ]);

    const res = await request(await app())
      .get(url)
      .expect(200);

    // Nothing inside 90 days...
    expect(res.body.activity.commits).toBe(0);
    // ...but the repository is plainly two commits old, not empty.
    expect(res.body.lifetime).toMatchObject({ commits: 2, authors: 2 });
    expect(res.body.lifetime.firstCommitAt).toBe('2025-08-18T10:00:00.000Z');
    expect(res.body.lifetime.lastCommitAt).toBe('2025-08-18T11:00:00.000Z');
  });

  it('serves the four pipeline states, cancelled kept apart from failed', async () => {
    await repositories.syncWorkspace('demandai', [repository()], NOW);
    const stored = await repositories.findByEntityRef(
      'component:default/oxp-backend',
    );
    await pipelines.replaceForRepository(stored!.id, [
      {
        uuid: '{a}',
        state: 'COMPLETED',
        result: 'SUCCESSFUL',
        createdAt: NOW.toISOString(),
      },
      {
        uuid: '{b}',
        state: 'COMPLETED',
        result: 'SUCCESSFUL',
        createdAt: NOW.toISOString(),
      },
      {
        uuid: '{c}',
        state: 'COMPLETED',
        result: 'FAILED',
        createdAt: NOW.toISOString(),
      },
      {
        uuid: '{d}',
        state: 'COMPLETED',
        result: 'STOPPED',
        createdAt: NOW.toISOString(),
      },
      { uuid: '{e}', state: 'IN_PROGRESS', createdAt: NOW.toISOString() },
    ]);

    const res = await request(await app())
      .get(url)
      .expect(200);

    expect(res.body.pipelines).toMatchObject({
      successful: 2,
      failed: 1,
      cancelled: 1,
      running: 1,
    });
    // 2 of 3 judged, not 2 of 4 completed.
    expect(res.body.pipelines.successRate).toBeCloseTo(2 / 3);
  });

  it('omits the success rate when there is nothing to judge', async () => {
    await repositories.syncWorkspace('demandai', [repository()], NOW);

    const res = await request(await app())
      .get(url)
      .expect(200);

    expect(res.body.pipelines).toMatchObject({
      successful: 0,
      failed: 0,
      cancelled: 0,
      running: 0,
    });
    expect(res.body.pipelines.successRate).toBeUndefined();
  });

  it('authenticates the caller', async () => {
    await repositories.syncWorkspace('demandai', [repository()], NOW);

    await request(await app())
      .get(url)
      .set('Authorization', mockCredentials.user.header())
      .expect(200);
  });

  describe('GET /repositories', () => {
    const fleetUrl = '/repositories';

    async function seedScored(
      slug: string,
      total: number,
      band: string,
      availableWeight = 85,
    ) {
      await repositories.syncWorkspace(
        'demandai',
        [repository({ slug, name: slug })],
        NOW,
      );
      const stored = await repositories.findByEntityRef(
        `component:default/${slug}`,
      );
      await scores.record(
        stored!.id,
        { total, band, availableWeight, breakdown: [] },
        NOW,
      );
      return stored!.id;
    }

    it('returns an empty estate before anything is ingested', async () => {
      const res = await request(await app())
        .get(fleetUrl)
        .expect(200);

      expect(res.body.repositories).toEqual([]);
      expect(res.body.counts).toEqual({
        healthy: 0,
        needsAttention: 0,
        critical: 0,
        unscored: 0,
      });
    });

    /**
     * Seeds a whole estate at once.
     *
     * `syncWorkspace` is a full sync -- anything absent from the list is marked
     * not-live -- so the repositories have to be registered together rather
     * than one call per repository.
     */
    async function seedEstate(
      rows: Array<{
        slug: string;
        total: number;
        band: string;
        runAt?: string;
      }>,
    ) {
      await repositories.syncWorkspace(
        'demandai',
        rows.map(r => repository({ slug: r.slug, name: r.slug })),
        NOW,
      );
      for (const row of rows) {
        const stored = await repositories.findByEntityRef(
          `component:default/${row.slug}`,
        );
        await scores.record(
          stored!.id,
          {
            total: row.total,
            band: row.band,
            availableWeight: 85,
            breakdown: [],
          },
          NOW,
        );
        if (row.runAt) {
          await pipelines.replaceForRepository(stored!.id, [
            {
              uuid: `{${row.slug}}`,
              state: 'COMPLETED',
              result: 'SUCCESSFUL',
              createdAt: row.runAt,
            },
          ]);
        }
      }
    }

    const slugs = async () =>
      (
        await request(await app())
          .get(fleetUrl)
          .expect(200)
      ).body.repositories.map((r: any) => r.slug);

    it('orders by build week, newest first', async () => {
      // Deliberately a WEEK apart, and the newer one is the healthier. The
      // earlier version of this test used 26 and 27 August, which are two
      // hours and one calendar day apart but the same ISO week -- so once the
      // bucket widened it would have passed while being decided entirely by
      // score, testing nothing it claimed to.
      await seedEstate([
        {
          slug: 'built-this-week',
          total: 95,
          band: 'healthy',
          runAt: '2026-09-01T01:00:00.000Z',
        },
        {
          slug: 'built-last-week',
          total: 40,
          band: 'critical',
          runAt: '2026-08-26T23:00:00.000Z',
        },
      ]);

      expect(await slugs()).toEqual(['built-this-week', 'built-last-week']);
    });

    it('ranks by worst score within a build week', async () => {
      // Two things at once. The weaker repository built LATER in the week, so
      // ordering on the instant would put it first for the wrong reason -- and
      // it must still come first, for the right one: worst score leads.
      await seedEstate([
        {
          slug: 'weak',
          total: 40,
          band: 'critical',
          runAt: '2026-08-28T18:00:00.000Z',
        },
        {
          slug: 'strong',
          total: 95,
          band: 'healthy',
          runAt: '2026-08-24T06:00:00.000Z',
        },
      ]);

      expect(await slugs()).toEqual(['weak', 'strong']);
    });

    it('ranks by score across different days inside one week', async () => {
      // The reason the bucket widened. These are four calendar days apart, so
      // under the old day bucket the healthy repository led purely because it
      // built more recently -- which is what put a 95 at the top of the real
      // dashboard while 43 repositories sat critical below it.
      await seedEstate([
        {
          slug: 'healthy-and-recent',
          total: 95,
          band: 'healthy',
          runAt: '2026-08-28T09:00:00.000Z',
        },
        {
          slug: 'critical-and-older',
          total: 17,
          band: 'critical',
          runAt: '2026-08-24T09:00:00.000Z',
        },
      ]);

      expect(await slugs()).toEqual([
        'critical-and-older',
        'healthy-and-recent',
      ]);
    });

    it('puts a Sunday and the Monday after it in different weeks', async () => {
      // The ISO boundary, which is the one thing a Monday-start week can get
      // wrong: 30 August 2026 is a Sunday, 31 August the Monday after.
      await seedEstate([
        {
          slug: 'monday',
          total: 99,
          band: 'healthy',
          runAt: '2026-08-31T00:30:00.000Z',
        },
        {
          slug: 'sunday-before',
          total: 10,
          band: 'critical',
          runAt: '2026-08-30T23:30:00.000Z',
        },
      ]);

      expect(await slugs()).toEqual(['monday', 'sunday-before']);
    });

    it('sorts a repository that has never run a pipeline last', async () => {
      // Not the same as a run that failed, and it must not lead the list just
      // because there is nothing to compare. 47 of 96 are in this state.
      await seedEstate([
        { slug: 'never-built', total: 99, band: 'healthy' },
        {
          slug: 'built',
          total: 20,
          band: 'critical',
          runAt: '2026-08-27T06:00:00.000Z',
        },
      ]);

      expect(await slugs()).toEqual(['built', 'never-built']);
    });

    it('ranks the never-built block worst first too', async () => {
      await seedEstate([
        { slug: 'poor', total: 20, band: 'critical' },
        { slug: 'fine', total: 80, band: 'healthy' },
      ]);

      expect(await slugs()).toEqual(['poor', 'fine']);
    });

    it('sorts an unscored repository last, not first', async () => {
      // The trap in worst-first ordering: no score is not a score of zero, and
      // putting it at the top would assert it is the worst in the estate.
      await repositories.syncWorkspace(
        'demandai',
        [
          repository({ slug: 'scored-badly', name: 'scored-badly' }),
          repository({ slug: 'never-scored', name: 'never-scored' }),
        ],
        NOW,
      );
      const stored = await repositories.findByEntityRef(
        'component:default/scored-badly',
      );
      await scores.record(
        stored!.id,
        { total: 3, band: 'critical', availableWeight: 85, breakdown: [] },
        NOW,
      );

      expect(await slugs()).toEqual(['scored-badly', 'never-scored']);
    });

    it('names a creator and contributors on every row', async () => {
      await seedEstate([
        {
          slug: 'built',
          total: 70,
          band: 'healthy',
          runAt: '2026-08-27T06:00:00.000Z',
        },
      ]);
      const stored = await repositories.findByEntityRef(
        'component:default/built',
      );
      await commits.insertMany(stored!.id, [
        commit({
          hash: 'first',
          committedAt: '2026-08-01T09:00:00.000Z',
          authorEmail: 'ada@demandai.co',
        }),
        commit({
          hash: 'second',
          committedAt: '2026-08-20T09:00:00.000Z',
          authorEmail: 'ada.l@gmail.com',
        }),
      ]);

      const res = await request(await app(AuthorizeResult.ALLOW, register()))
        .get(fleetUrl)
        .expect(200);
      const row = res.body.repositories.find((r: any) => r.slug === 'built');

      expect(row.createdBy).toMatchObject({
        name: 'Ada Lovelace',
        importedHistory: false,
      });
      // One human, two addresses, one name -- not two contributors.
      expect(row.contributors).toEqual(['Ada Lovelace']);
    });

    it('asks for creators and contributors once each, not once per repository', async () => {
      // Both feed a column on every row, so an N+1 here lands squarely in the
      // endpoint the two-second page load depends on.
      await seedEstate([
        { slug: 'a', total: 50, band: 'needs-attention' },
        { slug: 'b', total: 60, band: 'needs-attention' },
        { slug: 'c', total: 70, band: 'healthy' },
      ]);

      const first = jest.spyOn(commits, 'firstCommitForRepositories');
      const contrib = jest.spyOn(commits, 'contributorsForRepositories');
      await request(await app())
        .get(fleetUrl)
        .expect(200);

      expect(first).toHaveBeenCalledTimes(1);
      expect(contrib).toHaveBeenCalledTimes(1);
      first.mockRestore();
      contrib.mockRestore();
    });

    it('asks for the estate pipeline runs once, not once per repository', async () => {
      // The listing orders by this, so a per-repository lookup would be an N+1
      // in the one endpoint the two-second page load depends on.
      await seedEstate([
        {
          slug: 'a',
          total: 50,
          band: 'needs-attention',
          runAt: '2026-08-27T06:00:00.000Z',
        },
        {
          slug: 'b',
          total: 60,
          band: 'needs-attention',
          runAt: '2026-08-27T07:00:00.000Z',
        },
      ]);

      const spy = jest.spyOn(pipelines, 'lastRunForRepositories');
      await slugs();

      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockRestore();
    });

    it('sorts unscored repositories last, not first', async () => {
      await seedScored('scored', 10, 'critical');
      await repositories.syncWorkspace(
        'demandai',
        [
          repository({ slug: 'scored', name: 'scored' }),
          repository({ slug: 'unscored', name: 'unscored' }),
        ],
        NOW,
      );

      const res = await request(await app())
        .get(fleetUrl)
        .expect(200);

      // An absence of information must not outrank a real problem.
      expect(res.body.repositories.map((r: any) => r.slug)).toEqual([
        'scored',
        'unscored',
      ]);
      expect(res.body.repositories[1].score).toBeUndefined();
    });

    it('counts each band and the unscored separately', async () => {
      await seedScored('a', 90, 'healthy');
      await seedScored('b', 55, 'needs-attention');
      await seedScored('c', 10, 'critical');
      await repositories.syncWorkspace(
        'demandai',
        ['a', 'b', 'c', 'd'].map(slug => repository({ slug, name: slug })),
        NOW,
      );

      const res = await request(await app())
        .get(fleetUrl)
        .expect(200);

      expect(res.body.counts).toEqual({
        healthy: 1,
        needsAttention: 1,
        critical: 1,
        unscored: 1,
      });
    });

    it('serves only the newest score per repository', async () => {
      const id = await seedScored('alpha', 10, 'critical');
      await scores.record(
        id,
        { total: 90, band: 'healthy', availableWeight: 85, breakdown: [] },
        new Date('2026-08-22T12:00:00.000Z'),
      );

      const res = await request(await app())
        .get(fleetUrl)
        .expect(200);

      expect(res.body.repositories[0].score.total).toBe(90);
      expect(res.body.counts.healthy).toBe(1);
    });

    it('carries the proposed owner so the estate can be read at a glance', async () => {
      await repositories.syncWorkspace('demandai', [repository()], NOW);
      const stored = await repositories.findByEntityRef(
        'component:default/oxp-backend',
      );
      await db.client('ownership_candidate').insert({
        repository_id: stored!.id,
        rank: 1,
        is_proposed: true,
        author_name: 'Brijesh Gupta',
        author_email: 'brijesh.gupta@demandai.co',
        commits: 187,
        window_commits: 214,
        window_days: 90,
        source: 'commit-history',
        resolved_at: NOW,
      });

      const res = await request(await app())
        .get('/repositories')
        .expect(200);

      expect(res.body.repositories[0].proposedOwner).toEqual({
        name: 'Brijesh Gupta',
        email: 'brijesh.gupta@demandai.co',
        commits: 187,
      });
    });

    it('omits the proposed owner for a repository nobody clearly owns', async () => {
      await repositories.syncWorkspace('demandai', [repository()], NOW);
      const stored = await repositories.findByEntityRef(
        'component:default/oxp-backend',
      );
      // A candidate exists, but the resolver was not confident.
      await db.client('ownership_candidate').insert({
        repository_id: stored!.id,
        rank: 1,
        is_proposed: false,
        author_name: 'Ada Lovelace',
        author_email: 'ada@demandai.co',
        commits: 10,
        window_commits: 40,
        window_days: 90,
        source: 'commit-history',
        resolved_at: NOW,
      });

      const res = await request(await app())
        .get('/repositories')
        .expect(200);

      expect(res.body.repositories[0].proposedOwner).toBeUndefined();
    });

    it('reports the nominal weight so a partial score cannot be misread', async () => {
      await seedScored('alpha', 88, 'healthy', 85);

      const res = await request(await app())
        .get(fleetUrl)
        .expect(200);

      expect(res.body.nominalWeight).toBe(30);
      expect(res.body.repositories[0].score.availableWeight).toBe(85);
    });

    it('excludes repositories that are no longer live', async () => {
      await seedScored('gone', 10, 'critical');
      await repositories.syncWorkspace('demandai', [], NOW);

      const res = await request(await app())
        .get(fleetUrl)
        .expect(200);

      expect(res.body.repositories).toEqual([]);
    });

    it('can be filtered to one workspace', async () => {
      await seedScored('alpha', 10, 'critical');
      await repositories.syncWorkspace(
        'other',
        [repository({ workspace: 'other', slug: 'beta', name: 'beta' })],
        NOW,
      );

      const all = await request(await app())
        .get(fleetUrl)
        .expect(200);
      const filtered = await request(await app())
        .get(`${fleetUrl}?workspace=other`)
        .expect(200);

      expect(all.body.repositories).toHaveLength(2);
      expect(filtered.body.repositories.map((r: any) => r.slug)).toEqual([
        'beta',
      ]);
    });

    it('refuses when the permission policy denies', async () => {
      await request(await app(AuthorizeResult.DENY))
        .get(fleetUrl)
        .expect(403);
    });
  });
});
