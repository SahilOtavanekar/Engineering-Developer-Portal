import { mockServices } from '@backstage/backend-test-utils';
import { FakeBitbucketClient } from '../bitbucket/FakeBitbucketClient';
import type { BitbucketClient, BitbucketRepository } from '../bitbucket/types';
import { BranchStore } from '../database/BranchStore';
import { DeploymentStore } from '../database/DeploymentStore';
import { PipelineStore } from '../database/PipelineStore';
import { RepositoryStore } from '../database/RepositoryStore';
import { SyncStateStore } from '../database/SyncStateStore';
import { stubBitbucketClient } from '../__testUtils__/bitbucket';
import {
  startFleetTestDatabase,
  type FleetTestDatabase,
} from '../__testUtils__/database';
import { RepositoryDetailIngestionService } from './RepositoryDetailIngestionService';

const NOW = new Date('2026-08-21T12:00:00.000Z');
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

describe('RepositoryDetailIngestionService', () => {
  let db: FleetTestDatabase;
  let repositories: RepositoryStore;
  let branches: BranchStore;
  let pipelines: PipelineStore;
  let deployments: DeploymentStore;
  let syncState: SyncStateStore;

  const build = (client: BitbucketClient) =>
    new RepositoryDetailIngestionService({
      client,
      repositories,
      branches,
      pipelines,
      deployments,
      syncState,
      logger: mockServices.logger.mock(),
    });

  beforeAll(async () => {
    db = await startFleetTestDatabase();
    repositories = new RepositoryStore(db.client);
    branches = new BranchStore(db.client);
    pipelines = new PipelineStore(db.client);
    deployments = new DeploymentStore(db.client);
    syncState = new SyncStateStore(db.client);
  });

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await db.client('branch').delete();
    await db.client('pipeline_run').delete();
    await db.client('deployment').delete();
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

  function clientFor(slug: string) {
    return new FakeBitbucketClient([repository(slug)])
      .withRootFiles('demandai', slug, [
        'README.md',
        'package.json',
        'Dockerfile',
      ])
      .withFileContent('demandai', slug, {
        'package.json': JSON.stringify({
          dependencies: { react: '^18.0.0' },
          devDependencies: { typescript: '^5.0.0' },
        }),
      })
      .withBranches(
        'demandai',
        slug,
        FakeBitbucketClient.generateBranches(3, 7, NOW),
      )
      .withPipelineRuns(
        'demandai',
        slug,
        FakeBitbucketClient.generatePipelineRuns(8, 2, NOW),
      );
  }

  it('stores branches and pipeline runs for every live repository', async () => {
    await seed('alpha');

    const summary = await build(clientFor('alpha')).ingest('demandai', NOW);

    expect(summary).toMatchObject({
      repositories: 1,
      branches: 10,
      pipelineRuns: 10,
      rootListings: 1,
      stacksDerived: 1,
      failures: 0,
    });
  });

  it('summarises branch staleness against the window', async () => {
    const id = await seed('alpha');

    await build(clientFor('alpha')).ingest('demandai', NOW);

    await expect(branches.summary(id, WINDOW_START)).resolves.toEqual({
      total: 10,
      active: 3,
      stale: 7,
    });
  });

  it('summarises pipeline results', async () => {
    const id = await seed('alpha');

    await build(clientFor('alpha')).ingest('demandai', NOW);
    const summary = await pipelines.summary(id);

    expect(summary).toMatchObject({
      completed: 10,
      successful: 8,
      failed: 2,
      inProgress: 0,
      lastResult: 'SUCCESSFUL',
    });
  });

  it('marks the default branch', async () => {
    const id = await seed('alpha');

    await build(clientFor('alpha')).ingest('demandai', NOW);
    const rows = await db
      .client('branch')
      .where({ repository_id: id, is_default: true })
      .select('name');

    expect(rows.map((r: any) => r.name)).toEqual(['main']);
  });

  it('replaces snapshots rather than accumulating them', async () => {
    const id = await seed('alpha');
    const service = build(clientFor('alpha'));

    await service.ingest('demandai', NOW);
    await service.ingest('demandai', NOW);

    await expect(branches.summary(id, WINDOW_START)).resolves.toMatchObject({
      total: 10,
    });
    const runs = await pipelines.summary(id);
    expect(runs.completed).toBe(10);
  });

  it('removes a branch that has been deleted upstream', async () => {
    const id = await seed('alpha');
    const client = new FakeBitbucketClient([repository('alpha')]).withBranches(
      'demandai',
      'alpha',
      FakeBitbucketClient.generateBranches(3, 0, NOW),
    );

    await build(clientFor('alpha')).ingest('demandai', NOW);
    await build(client).ingest('demandai', NOW);

    await expect(branches.summary(id, WINDOW_START)).resolves.toMatchObject({
      total: 3,
    });
  });

  it('excludes in-progress runs from the completed count', async () => {
    const id = await seed('alpha');
    const client = new FakeBitbucketClient([
      repository('alpha'),
    ]).withPipelineRuns('demandai', 'alpha', [
      {
        uuid: '{running}',
        state: 'IN_PROGRESS',
        createdAt: NOW.toISOString(),
      },
      ...FakeBitbucketClient.generatePipelineRuns(2, 0, NOW),
    ]);

    await build(client).ingest('demandai', NOW);

    await expect(pipelines.summary(id)).resolves.toMatchObject({
      completed: 2,
      inProgress: 1,
    });
  });

  it('handles a repository with no branches or pipelines', async () => {
    const id = await seed('empty');

    const summary = await build(
      new FakeBitbucketClient([repository('empty')]),
    ).ingest('demandai', NOW);

    expect(summary).toMatchObject({
      branches: 0,
      pipelineRuns: 0,
      failures: 0,
    });
    await expect(branches.summary(id, WINDOW_START)).resolves.toMatchObject({
      total: 0,
    });
  });

  it('carries on when one repository fails', async () => {
    await seed('alpha');
    await repositories.syncWorkspace(
      'demandai',
      [repository('alpha'), repository('beta')],
      NOW,
    );

    const flaky = stubBitbucketClient({
      listBranches: async (_w, slug) => {
        if (slug === 'alpha') throw new Error('unreachable');
        return FakeBitbucketClient.generateBranches(2, 0, NOW);
      },
    });

    const summary = await build(flaky).ingest('demandai', NOW);

    expect(summary.failures).toBe(1);
    expect(summary.branches).toBe(2);
  });

  it('records a partial failure rather than claiming success', async () => {
    await seed('alpha');
    const failing = stubBitbucketClient({
      listBranches: async () => {
        throw new Error('boom');
      },
    });

    await build(failing).ingest('demandai', NOW);

    const state = await syncState.get('repository-detail:demandai');
    expect(Number(state!.consecutive_failures)).toBe(1);
    expect(state!.last_success_at).toBeNull();
  });

  it('names its sync_state resource per workspace', () => {
    expect(RepositoryDetailIngestionService.resourceKey('demandai')).toBe(
      'repository-detail:demandai',
    );
  });

  describe('technology stack derivation', () => {
    it('stores the ecosystems and frameworks it found', async () => {
      const id = await seed('alpha');

      await build(clientFor('alpha')).ingest('demandai', NOW);
      const stored = await repositories.findByEntityRef(
        'component:default/alpha',
      );

      expect(stored!.id).toBe(id);
      expect(stored!.tech_stack).toEqual(
        expect.arrayContaining(['Node.js', 'Docker', 'React', 'TypeScript']),
      );
    });

    it('infers a language, which Bitbucket does not report for most repos', async () => {
      await seed('alpha');

      await build(clientFor('alpha')).ingest('demandai', NOW);
      const stored = await repositories.findByEntityRef(
        'component:default/alpha',
      );

      expect(stored!.derived_language).toBe('TypeScript');
    });

    it('leaves the stack empty for a repository with no manifest', async () => {
      await seed('bare');
      const client = new FakeBitbucketClient([
        repository('bare'),
      ]).withRootFiles('demandai', 'bare', ['README.md', 'LICENSE']);

      const summary = await build(client).ingest('demandai', NOW);
      const stored = await repositories.findByEntityRef(
        'component:default/bare',
      );

      expect(summary.stacksDerived).toBe(0);
      expect(stored!.tech_stack).toEqual([]);
      expect(stored!.derived_language).toBeNull();
    });

    it('only fetches manifests whose contents add framework detail', async () => {
      await seed('alpha');
      const client = new FakeBitbucketClient([
        repository('alpha'),
      ]).withRootFiles('demandai', 'alpha', [
        'Dockerfile',
        'template.yaml',
        'README.md',
      ]);

      const before = client.requestCount;
      await build(client).ingest('demandai', NOW);

      // branches + pipelines + root listing, and no manifest fetch: none of
      // those three files would tell us anything more than their name already does.
      expect(client.requestCount - before).toBe(3);
    });
  });

  describe('stale branch detail', () => {
    it('names the longest-abandoned branches, oldest first', async () => {
      const id = await seed('alpha');

      await build(clientFor('alpha')).ingest('demandai', NOW);
      const stalest = await branches.stalest(id, WINDOW_START);

      expect(stalest).toHaveLength(5);
      // The generator ages stale branches progressively; the oldest leads.
      const times = stalest.map(b => b.lastCommitAt!.getTime());
      expect([...times].sort((a, b) => a - b)).toEqual(times);
    });

    it('never reports the default branch as abandoned', async () => {
      const id = await seed('alpha');

      await build(clientFor('alpha')).ingest('demandai', NOW);
      const stalest = await branches.stalest(id, WINDOW_START);

      expect(stalest.map(b => b.name)).not.toContain('main');
    });

    it('returns nothing when every branch is active', async () => {
      const id = await seed('fresh');
      const client = new FakeBitbucketClient([
        repository('fresh'),
      ]).withBranches(
        'demandai',
        'fresh',
        FakeBitbucketClient.generateBranches(3, 0, NOW),
      );

      await build(client).ingest('demandai', NOW);

      await expect(branches.stalest(id, WINDOW_START)).resolves.toEqual([]);
    });

    it('honours the limit', async () => {
      const id = await seed('alpha');

      await build(clientFor('alpha')).ingest('demandai', NOW);

      await expect(branches.stalest(id, WINDOW_START, 2)).resolves.toHaveLength(
        2,
      );
    });
  });
  describe('classification', () => {
    const environments: Array<[string, string]> = [
      ['dev', 'Test'],
      ['production', 'Production'],
    ];

    async function classify(slug: string, client: FakeBitbucketClient) {
      const id = await seed(slug);
      await build(client).ingest('demandai', NOW);
      const stored = await repositories.findByEntityRef(
        `component:default/${slug}`,
      );
      return {
        id,
        type: stored!.derived_type,
        lifecycle: stored!.derived_lifecycle,
      };
    }

    it('calls a React repository a website that is live', async () => {
      const client = new FakeBitbucketClient([repository('front')])
        .withRootFiles('demandai', 'front', ['package.json'])
        .withFileContent('demandai', 'front', {
          'package.json': JSON.stringify({
            dependencies: { react: '^18.0.0' },
          }),
        })
        .withPipelineRuns(
          'demandai',
          'front',
          FakeBitbucketClient.generatePipelineRuns(4, 0, NOW),
        )
        .withDeployments(
          'demandai',
          'front',
          FakeBitbucketClient.generateDeployments(environments, NOW),
        );

      await expect(classify('front', client)).resolves.toMatchObject({
        type: 'website',
        lifecycle: 'production',
      });
    });

    it('calls a containerised backend a service that is live', async () => {
      const client = new FakeBitbucketClient([repository('api')])
        .withRootFiles('demandai', 'api', ['Dockerfile', 'requirements.txt'])
        .withPipelineRuns(
          'demandai',
          'api',
          FakeBitbucketClient.generatePipelineRuns(4, 0, NOW),
        )
        .withDeployments(
          'demandai',
          'api',
          FakeBitbucketClient.generateDeployments(environments, NOW),
        );

      await expect(classify('api', client)).resolves.toMatchObject({
        type: 'service',
        lifecycle: 'production',
      });
    });

    it('calls a built but never-deployed repository experimental', async () => {
      const client = new FakeBitbucketClient([repository('built')])
        .withRootFiles('demandai', 'built', ['Dockerfile'])
        .withPipelineRuns(
          'demandai',
          'built',
          FakeBitbucketClient.generatePipelineRuns(4, 0, NOW),
        );

      await expect(classify('built', client)).resolves.toMatchObject({
        type: 'service',
        lifecycle: 'experimental',
      });
    });

    it('claims nothing about a dormant repository', async () => {
      const client = new FakeBitbucketClient([repository('quiet')]);

      await expect(classify('quiet', client)).resolves.toMatchObject({
        type: 'unknown',
        lifecycle: 'unknown',
      });
    });

    it('counts only the repositories it could say something about', async () => {
      await seed('quiet');
      const summary = await build(
        new FakeBitbucketClient([repository('quiet')]),
      ).ingest('demandai', NOW);

      expect(summary.classified).toBe(0);
    });

    it('ignores a deployment that never completed when deciding lifecycle', async () => {
      const client = new FakeBitbucketClient([repository('rolled-back')])
        .withRootFiles('demandai', 'rolled-back', ['Dockerfile'])
        .withPipelineRuns(
          'demandai',
          'rolled-back',
          FakeBitbucketClient.generatePipelineRuns(4, 0, NOW),
        )
        .withDeployments('demandai', 'rolled-back', [
          {
            uuid: '{undeployed}',
            environmentName: 'production',
            environmentType: 'Production',
            state: 'UNDEPLOYED',
            createdAt: NOW.toISOString(),
          },
        ]);

      await expect(classify('rolled-back', client)).resolves.toMatchObject({
        lifecycle: 'experimental',
      });
    });
  });

  describe('deployments', () => {
    const environments: Array<[string, string]> = [
      ['dev', 'Test'],
      ['staging', 'Staging'],
      ['production', 'Production'],
    ];

    it('records what is live in each environment', async () => {
      const id = await seed('alpha');
      const client = clientFor('alpha').withDeployments(
        'demandai',
        'alpha',
        FakeBitbucketClient.generateDeployments(environments, NOW),
      );

      const summary = await build(client).ingest('demandai', NOW);

      expect(summary).toMatchObject({ deployments: 3, failures: 0 });
      await expect(deployments.currentEnvironments(id)).resolves.toMatchObject([
        { environmentName: 'dev' },
        { environmentName: 'staging' },
        { environmentName: 'production' },
      ]);
    });

    it('does not ask a repository with no pipeline runs for deployments', async () => {
      // Bitbucket only records a deployment when a pipeline declares one, so
      // asking here would spend a request per repository to learn nothing.
      await seed('quiet');
      const client = new FakeBitbucketClient([repository('quiet')]);

      const summary = await build(client).ingest('demandai', NOW);

      expect(summary.deployments).toBe(0);
      expect(client.requestsFor('listDeployments')).toBe(0);
    });

    it('clears the snapshot when a repository loses its pipelines', async () => {
      // Without this the card would keep showing a release that no longer has
      // any pipeline behind it -- worse than showing nothing.
      const id = await seed('alpha');
      await build(
        clientFor('alpha').withDeployments(
          'demandai',
          'alpha',
          FakeBitbucketClient.generateDeployments(environments, NOW),
        ),
      ).ingest('demandai', NOW);
      expect(await deployments.count(id)).toBe(3);

      const withoutPipelines = new FakeBitbucketClient([repository('alpha')]);
      await build(withoutPipelines).ingest('demandai', NOW);

      expect(await deployments.count(id)).toBe(0);
      expect(withoutPipelines.requestsFor('listDeployments')).toBe(0);
    });

    it('reports no environments for a repository whose names do not match', async () => {
      // The common real case: bitbucket-pipelines.yml says `production` but
      // the configured environment is `Production`, so Bitbucket records
      // nothing. That is honest emptiness, not a failure.
      const id = await seed('mismatched');
      const client = clientFor('mismatched');

      const summary = await build(client).ingest('demandai', NOW);

      expect(summary).toMatchObject({ deployments: 0, failures: 0 });
      await expect(deployments.currentEnvironments(id)).resolves.toEqual([]);
    });

    it('replaces the snapshot rather than accumulating it', async () => {
      const id = await seed('alpha');
      const client = clientFor('alpha').withDeployments(
        'demandai',
        'alpha',
        FakeBitbucketClient.generateDeployments(environments, NOW),
      );

      await build(client).ingest('demandai', NOW);
      await build(client).ingest('demandai', NOW);

      await expect(deployments.count(id)).resolves.toBe(3);
    });
  });
});
