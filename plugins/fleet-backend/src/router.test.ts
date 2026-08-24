import { mockCredentials, mockServices } from '@backstage/backend-test-utils';
import { AuthorizeResult } from '@backstage/plugin-permission-common';
import express from 'express';
import request from 'supertest';
import type { BitbucketCommit, BitbucketRepository } from './bitbucket/types';
import { CommitStore } from './database/CommitStore';
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
  let scores: ScoreStore;

  async function app(
    result:
      | AuthorizeResult.ALLOW
      | AuthorizeResult.DENY = AuthorizeResult.ALLOW,
  ) {
    const router = await createRouter({
      repositories,
      commits,
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
    scores = new ScoreStore(db.client);
  });

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await db.client('repo_score').delete();
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

    it('orders worst first', async () => {
      await repositories.syncWorkspace(
        'demandai',
        [
          repository({ slug: 'good', name: 'good' }),
          repository({ slug: 'bad', name: 'bad' }),
          repository({ slug: 'middling', name: 'middling' }),
        ],
        NOW,
      );
      for (const [slug, total, band] of [
        ['good', 90, 'healthy'],
        ['bad', 10, 'critical'],
        ['middling', 55, 'needs-attention'],
      ] as const) {
        const stored = await repositories.findByEntityRef(
          `component:default/${slug}`,
        );
        await scores.record(
          stored!.id,
          { total, band, availableWeight: 85, breakdown: [] },
          NOW,
        );
      }

      const res = await request(await app())
        .get(fleetUrl)
        .expect(200);

      expect(res.body.repositories.map((r: any) => r.slug)).toEqual([
        'bad',
        'middling',
        'good',
      ]);
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
