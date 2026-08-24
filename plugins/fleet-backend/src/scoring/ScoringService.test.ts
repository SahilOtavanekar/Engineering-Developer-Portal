import { mockServices } from '@backstage/backend-test-utils';
import type { BitbucketCommit, BitbucketRepository } from '../bitbucket/types';
import { BranchStore } from '../database/BranchStore';
import { CommitStore } from '../database/CommitStore';
import { PipelineStore } from '../database/PipelineStore';
import { PullRequestStore } from '../database/PullRequestStore';
import { RepositoryStore } from '../database/RepositoryStore';
import { ScoreStore } from '../database/ScoreStore';
import { SyncStateStore } from '../database/SyncStateStore';
import {
  startFleetTestDatabase,
  type FleetTestDatabase,
} from '../__testUtils__/database';
import { PROVISIONAL_BANDS, ScoringEngine } from './ScoringEngine';
import { ScoringService } from './ScoringService';
import { activeCommitsScorer } from './scorers/activeCommits';
import { activeContributorsScorer } from './scorers/activeContributors';

const T1 = new Date('2026-08-21T09:00:00.000Z');
const T2 = new Date('2026-08-22T09:00:00.000Z');

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

function commit(hash: string, email: string, at: Date): BitbucketCommit {
  return {
    hash,
    committedAt: at.toISOString(),
    authorEmail: email,
    parentCount: 1,
  };
}

describe('ScoringService', () => {
  let db: FleetTestDatabase;
  let repositories: RepositoryStore;
  let commits: CommitStore;
  let branches: BranchStore;
  let pipelines: PipelineStore;
  let pullRequests: PullRequestStore;
  let scores: ScoreStore;
  let syncState: SyncStateStore;

  const engine = new ScoringEngine({
    bands: PROVISIONAL_BANDS,
    scorers: [
      { scorer: activeCommitsScorer({ target: 10 }), weight: 20 },
      { scorer: activeContributorsScorer({ target: 2 }), weight: 10 },
    ],
  });

  const build = () =>
    new ScoringService({
      engine,
      repositories,
      commits,
      branches,
      pipelines,
      pullRequests,
      scores,
      syncState,
      logger: mockServices.logger.mock(),
    });

  beforeAll(async () => {
    db = await startFleetTestDatabase();
    repositories = new RepositoryStore(db.client);
    commits = new CommitStore(db.client);
    branches = new BranchStore(db.client);
    pipelines = new PipelineStore(db.client);
    pullRequests = new PullRequestStore(db.client);
    scores = new ScoreStore(db.client);
    syncState = new SyncStateStore(db.client);
  });

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await db.client('repo_score').delete();
    await db.client('branch').delete();
    await db.client('pipeline_run').delete();
    await db.client('pull_request').delete();
    await db.client('commit').delete();
    await db.client('repository').delete();
    await db.client('sync_state').delete();
  });

  async function seed(slug: string, commitCount: number, authors: number) {
    await repositories.syncWorkspace('demandai', [repository(slug)], T1);
    const stored = await repositories.findByEntityRef(
      `component:default/${slug}`,
    );
    const rows = Array.from({ length: commitCount }, (_, i) =>
      commit(
        `${slug}-${i}`,
        `dev${i % Math.max(1, authors)}@demandai.co`,
        new Date(T1.getTime() - i * 3_600_000),
      ),
    );
    await commits.insertMany(stored!.id, rows);
    return stored!.id;
  }

  it('scores every live repository', async () => {
    await seed('alpha', 10, 2);

    const summary = await build().scoreAll('demandai', T1);

    expect(summary).toMatchObject({ scored: 1, failures: 0 });
  });

  it('gives a busy, multi-author repository a healthy score', async () => {
    const id = await seed('alpha', 10, 2);

    await build().scoreAll('demandai', T1);
    const score = await scores.latest(id);

    expect(score!.total).toBe(100);
    expect(score!.band).toBe('healthy');
  });

  it('marks a dormant repository critical', async () => {
    await repositories.syncWorkspace('demandai', [repository('idle')], T1);
    const stored = await repositories.findByEntityRef('component:default/idle');

    await build().scoreAll('demandai', T1);
    const score = await scores.latest(stored!.id);

    expect(score!.total).toBe(0);
    expect(score!.band).toBe('critical');
  });

  it('penalises a single-author repository even when it is busy', async () => {
    const id = await seed('solo', 20, 1);

    await build().scoreAll('demandai', T1);
    const score = await scores.latest(id);

    // Full marks on commits (20), half on contributors (5): 25 of 30.
    expect(score!.total).toBe(83);
    expect(score!.band).toBe('healthy');
  });

  it('records the band distribution across the estate', async () => {
    await seed('busy', 10, 2);
    await repositories.syncWorkspace(
      'demandai',
      [repository('busy'), repository('idle')],
      T1,
    );

    const summary = await build().scoreAll('demandai', T1);

    expect(summary.bands).toEqual({ healthy: 1, critical: 1 });
  });

  it('appends history rather than overwriting the previous score', async () => {
    const id = await seed('alpha', 10, 2);
    const service = build();

    await service.scoreAll('demandai', T1);
    await service.scoreAll('demandai', T2);

    await expect(scores.count(id)).resolves.toBe(2);
    const history = await scores.history(id);
    expect(history.map(h => new Date(h.computed_at).toISOString())).toEqual([
      T2.toISOString(),
      T1.toISOString(),
    ]);
  });

  it('persists the breakdown so a score can be explained', async () => {
    const id = await seed('alpha', 5, 1);

    await build().scoreAll('demandai', T1);
    const score = await scores.latest(id);

    expect(score!.breakdown).toEqual([
      expect.objectContaining({
        id: 'active-commits',
        detail: '5 commits in 90 days',
        points: 10,
      }),
      expect.objectContaining({
        id: 'active-contributors',
        detail: '1 contributor in 90 days',
        points: 5,
      }),
    ]);
  });

  it('records success in sync_state', async () => {
    await seed('alpha', 10, 2);

    await build().scoreAll('demandai', T1);

    const state = await syncState.get('scoring:demandai');
    expect(Number(state!.consecutive_failures)).toBe(0);
    expect(new Date(state!.last_success_at!).toISOString()).toBe(
      T1.toISOString(),
    );
  });

  it('does not score repositories that are no longer live', async () => {
    await seed('alpha', 10, 2);
    await repositories.syncWorkspace('demandai', [], T2);

    const summary = await build().scoreAll('demandai', T2);

    expect(summary.scored).toBe(0);
  });

  it('names its sync_state resource per workspace', () => {
    expect(ScoringService.resourceKey('demandai')).toBe('scoring:demandai');
  });
});
