import { mockServices } from '@backstage/backend-test-utils';
import type {
  BitbucketCommit,
  BitbucketDeployment,
  BitbucketRepository,
} from '../bitbucket/types';
import { CommitStore } from '../database/CommitStore';
import { DeploymentStore } from '../database/DeploymentStore';
import { OwnershipStore } from '../database/OwnershipStore';
import { RepositoryStore } from '../database/RepositoryStore';
import { ScoreStore } from '../database/ScoreStore';
import { SyncStateStore } from '../database/SyncStateStore';
import { CommitHistoryOwnershipResolver } from '../ownership/CommitHistoryOwnershipResolver';
import { OwnershipService } from '../ownership/OwnershipService';
import {
  startFleetTestDatabase,
  type FleetTestDatabase,
} from '../__testUtils__/database';
import {
  FleetRepositoryCollatorFactory,
  type FleetRepositoryDocument,
} from './FleetRepositoryCollatorFactory';

const NOW = new Date('2026-08-24T12:00:00.000Z');
const DAY = 86_400_000;

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
    createdAt: '2023-05-01T10:00:00.000Z',
    updatedAt: '2026-08-19T12:00:00.000Z',
    ...overrides,
  };
}

function commitsBy(email: string, n: number, offset = 0): BitbucketCommit[] {
  return Array.from({ length: n }, (_, i) => ({
    hash: `${email}-${offset + i}`,
    committedAt: new Date(NOW.getTime() - (offset + i) * DAY).toISOString(),
    authorName: 'Brijesh Gupta',
    authorEmail: email,
    parentCount: 1,
  }));
}

function deployment(
  overrides: Partial<BitbucketDeployment> = {},
): BitbucketDeployment {
  return {
    uuid: '{d1}',
    environmentName: 'production',
    environmentType: 'Production',
    state: 'COMPLETED',
    createdAt: NOW.toISOString(),
    ...overrides,
  };
}

describe('FleetRepositoryCollatorFactory', () => {
  let db: FleetTestDatabase;
  let repositories: RepositoryStore;
  let commits: CommitStore;
  let scores: ScoreStore;
  let ownership: OwnershipStore;
  let deployments: DeploymentStore;
  let syncState: SyncStateStore;

  const build = () =>
    new FleetRepositoryCollatorFactory({
      repositories,
      scores,
      ownership,
      deployments,
      logger: mockServices.logger.mock(),
    });

  async function collect(): Promise<FleetRepositoryDocument[]> {
    const stream = await build().getCollator();
    const documents: FleetRepositoryDocument[] = [];
    for await (const document of stream) {
      documents.push(document as FleetRepositoryDocument);
    }
    return documents;
  }

  beforeAll(async () => {
    db = await startFleetTestDatabase();
    repositories = new RepositoryStore(db.client);
    commits = new CommitStore(db.client);
    scores = new ScoreStore(db.client);
    ownership = new OwnershipStore(db.client);
    deployments = new DeploymentStore(db.client);
    syncState = new SyncStateStore(db.client);
  });

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await db.client('ownership_candidate').delete();
    await db.client('deployment').delete();
    await db.client('repo_score').delete();
    await db.client('commit').delete();
    await db.client('repository').delete();
    await db.client('sync_state').delete();
  });

  async function seed(overrides: Partial<BitbucketRepository> = {}) {
    await repositories.syncWorkspace('demandai', [repository(overrides)], NOW);
    const stored = await repositories.findByEntityRef(
      `component:default/${overrides.slug ?? 'oxp-backend'}`,
    );
    return stored!.id;
  }

  it('names its index and honours the fleet read permission', () => {
    const factory = build();

    expect(factory.type).toBe('fleet-repository');
    expect(factory.visibilityPermission?.name).toBe('fleet.repository.read');
  });

  it('emits one document per live repository', async () => {
    await repositories.syncWorkspace(
      'demandai',
      [repository(), repository({ slug: 'crm', name: 'CRM' })],
      NOW,
    );

    const documents = await collect();

    expect(documents.map(d => d.slug)).toEqual(['crm', 'oxp-backend']);
  });

  it('points a result at the entity page, where the detail is', async () => {
    await seed();

    const [document] = await collect();

    expect(document.location).toBe('/catalog/default/component/oxp-backend');
    expect(document.entityRef).toBe('component:default/oxp-backend');
  });

  it('excludes a repository that is no longer live', async () => {
    await seed();
    await repositories.syncWorkspace('demandai', [], NOW);

    await expect(collect()).resolves.toEqual([]);
  });

  it('indexes the technology stack, which the catalog knows nothing about', async () => {
    const id = await seed();
    await repositories.setTechStack(id, ['Python', 'AWS SAM'], 'Python');

    const [document] = await collect();

    expect(document.technologies).toEqual(['Python', 'AWS SAM']);
    expect(document.language).toBe('Python');
    expect(document.text).toContain('AWS SAM');
  });

  it('falls back to the derived language when Bitbucket reports none', async () => {
    // True for 89 of 95 repositories in this estate.
    const id = await seed();
    await repositories.setTechStack(id, ['Node.js'], 'TypeScript');

    const [document] = await collect();

    expect(document.language).toBe('TypeScript');
  });

  it('indexes the score and band so they can be searched and faceted', async () => {
    const id = await seed();
    await scores.record(
      id,
      {
        total: 88,
        band: 'healthy',
        availableWeight: 85,
        breakdown: [],
      },
      NOW,
    );

    const [document] = await collect();

    expect(document).toMatchObject({ score: 88, band: 'healthy' });
    expect(document.text).toContain('Healthy');
    // The catalog collator indexes the same name and links to the same page,
    // so this result has to be tellable apart from that one.
    expect(document.title).toBe('oxp-backend · 88 Healthy');
  });

  /**
   * Score rows are append-only, so a repository last scored before At Risk was
   * renamed from `critical` still carries the old name. Indexing it raw would
   * put a band in the facet list that no filter in the portal offers, and
   * label the result with a word the specification does not use.
   */
  it('indexes a pre-rename band under its current name', async () => {
    const id = await seed();
    await scores.record(
      id,
      { total: 20, band: 'critical', availableWeight: 85, breakdown: [] },
      NOW,
    );

    const [document] = await collect();

    expect(document.band).toBe('at-risk');
    expect(document.title).toBe('oxp-backend · 20 At risk');
  });

  it('says so in the text when a repository has never been scored', async () => {
    await seed();

    const [document] = await collect();

    expect(document.band).toBeUndefined();
    expect(document.text).toContain('Not scored');
    expect(document.title).toBe('oxp-backend · not scored');
  });

  it('indexes the environment types a repository reaches', async () => {
    const id = await seed();
    await deployments.replaceForRepository(id, [
      deployment({ uuid: '{p}', environmentType: 'Production' }),
      deployment({
        uuid: '{t}',
        environmentName: 'dev',
        environmentType: 'Test',
      }),
    ]);

    const [document] = await collect();

    // Promotion order, so a reader sees dev before production.
    expect(document.environments).toEqual(['Test', 'Production']);
    expect(document.text).toContain('Production');
  });

  it('groups environments by type, not by their inconsistent names', async () => {
    // `dev`, `Dev` and `development` are three spellings of one idea. Faceting
    // on the names would offer all three as separate choices.
    const id = await seed();
    await deployments.replaceForRepository(id, [
      deployment({
        uuid: '{a}',
        environmentName: 'dev',
        environmentType: 'Test',
      }),
      deployment({
        uuid: '{b}',
        environmentName: 'Dev',
        environmentType: 'Test',
      }),
    ]);

    const [document] = await collect();

    expect(document.environments).toEqual(['Test']);
  });

  it('ignores a deployment that never completed', async () => {
    const id = await seed();
    await deployments.replaceForRepository(id, [
      deployment({ uuid: '{x}', state: 'UNDEPLOYED' }),
    ]);

    const [document] = await collect();

    expect(document.environments).toEqual([]);
  });

  it('indexes the proposed owner by name', async () => {
    const id = await seed();
    await commits.insertMany(id, commitsBy('brijesh.gupta@demandai.co', 20));
    await new OwnershipService({
      resolver: new CommitHistoryOwnershipResolver({ commits }),
      repositories,
      ownership,
      syncState,
      logger: mockServices.logger.mock(),
    }).resolveAll('demandai', NOW);

    const [document] = await collect();

    expect(document.owner).toBe('Brijesh Gupta');
    expect(document.text).toContain('Brijesh Gupta');
  });

  it('never claims a derived owner is confirmed', async () => {
    // Everything in the catalog is still group:default/unowned.
    const id = await seed();
    await commits.insertMany(id, commitsBy('brijesh.gupta@demandai.co', 20));
    await new OwnershipService({
      resolver: new CommitHistoryOwnershipResolver({ commits }),
      repositories,
      ownership,
      syncState,
      logger: mockServices.logger.mock(),
    }).resolveAll('demandai', NOW);

    const [document] = await collect();

    expect(document.ownerConfirmed).toBe(false);
  });

  it('leaves the owner unset when nobody was proposed', async () => {
    await seed();

    const [document] = await collect();

    expect(document.owner).toBeUndefined();
  });

  it('includes the description and project key in the searchable text', async () => {
    await repositories.syncWorkspace(
      'demandai',
      [repository({ description: 'Order fulfilment service' })],
      NOW,
    );

    const [document] = await collect();

    expect(document.text).toContain('Order fulfilment service');
    expect(document.text).toContain('DDS');
  });

  it('survives a repository with nothing but a name', async () => {
    await repositories.syncWorkspace(
      'demandai',
      [
        {
          workspace: 'demandai',
          slug: 'bare',
          name: 'bare',
          url: 'https://bitbucket.org/demandai/bare',
          isPrivate: true,
          createdAt: NOW.toISOString(),
          updatedAt: NOW.toISOString(),
        },
      ],
      NOW,
    );

    const [document] = await collect();

    expect(document).toMatchObject({
      slug: 'bare',
      technologies: [],
      environments: [],
    });
    expect(document.title).toBe('bare · not scored');
    expect(document.text).toContain('bare');
  });

  it('reads the whole estate in a fixed number of queries', async () => {
    // An estate ten times this size must not cost ten times the queries.
    const many = Array.from({ length: 30 }, (_, i) =>
      repository({ slug: `repo-${i}`, name: `repo ${i}` }),
    );
    await repositories.syncWorkspace('demandai', many, NOW);

    const queries: string[] = [];
    const listener = (query: { sql: string }) => queries.push(query.sql);
    db.client.on('query', listener);
    const documents = await collect();
    db.client.off('query', listener);

    expect(documents).toHaveLength(30);
    // One listing plus three batched lookups. Generous ceiling so the test
    // fails on an N+1 rather than on an extra bookkeeping query.
    expect(queries.length).toBeLessThanOrEqual(8);
  });
});
