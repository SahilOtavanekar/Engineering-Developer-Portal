import type {
  BitbucketDeployment,
  BitbucketRepository,
} from '../bitbucket/types';
import {
  startFleetTestDatabase,
  type FleetTestDatabase,
} from '../__testUtils__/database';
import { DeploymentStore } from './DeploymentStore';
import { RepositoryStore } from './RepositoryStore';

const NOW = new Date('2026-08-21T12:00:00.000Z');
const HOUR = 3_600_000;

function repository(slug = 'oxp-backend'): BitbucketRepository {
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

function deployment(
  overrides: Partial<BitbucketDeployment> = {},
): BitbucketDeployment {
  return {
    uuid: '{deploy-1}',
    number: 1,
    environmentName: 'production',
    environmentType: 'Production',
    state: 'COMPLETED',
    releaseName: '#412',
    commitHash: 'abc123',
    createdAt: NOW.toISOString(),
    lastUpdatedAt: NOW.toISOString(),
    ...overrides,
  };
}

describe('DeploymentStore', () => {
  let db: FleetTestDatabase;
  let deployments: DeploymentStore;
  let repositories: RepositoryStore;
  let repositoryId: number;

  beforeAll(async () => {
    db = await startFleetTestDatabase();
    deployments = new DeploymentStore(db.client);
    repositories = new RepositoryStore(db.client);
  });

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await db.client('deployment').delete();
    await db.client('repository').delete();
    await repositories.syncWorkspace('demandai', [repository()], NOW);
    const stored = await repositories.findByEntityRef(
      'component:default/oxp-backend',
    );
    repositoryId = stored!.id;
  });

  it('stores a deployment with its release and environment', async () => {
    await deployments.replaceForRepository(repositoryId, [deployment()]);

    const [row] = await db.client('deployment').select();

    expect(row).toMatchObject({
      uuid: '{deploy-1}',
      environment_name: 'production',
      environment_type: 'Production',
      state: 'COMPLETED',
      release_name: '#412',
      commit_hash: 'abc123',
    });
  });

  it('replaces the previous snapshot rather than accumulating', async () => {
    await deployments.replaceForRepository(repositoryId, [
      deployment({ uuid: '{old}' }),
    ]);
    await deployments.replaceForRepository(repositoryId, [
      deployment({ uuid: '{new}' }),
    ]);

    const rows = await db.client('deployment').select('uuid');

    expect(rows).toEqual([{ uuid: '{new}' }]);
  });

  it('clears the snapshot when a repository stops reporting deployments', async () => {
    await deployments.replaceForRepository(repositoryId, [deployment()]);

    expect(await deployments.replaceForRepository(repositoryId, [])).toBe(0);
    expect(await deployments.count(repositoryId)).toBe(0);
  });

  it('does not mix one repository into another', async () => {
    await repositories.syncWorkspace(
      'demandai',
      [repository(), repository('crm')],
      NOW,
    );
    const other = await repositories.findByEntityRef('component:default/crm');
    await deployments.replaceForRepository(repositoryId, [deployment()]);
    await deployments.replaceForRepository(other!.id, [
      deployment({ uuid: '{crm}', environmentName: 'Staging' }),
    ]);

    const environments = await deployments.currentEnvironments(repositoryId);

    expect(environments.map(e => e.environmentName)).toEqual(['production']);
    expect(await deployments.count(other!.id)).toBe(1);
  });

  describe('currentEnvironments', () => {
    it('returns nothing for a repository with no deployment records', async () => {
      expect(await deployments.currentEnvironments(repositoryId)).toEqual([]);
    });

    it('keeps only the newest deployment per environment', async () => {
      await deployments.replaceForRepository(repositoryId, [
        deployment({
          uuid: '{old}',
          releaseName: '#410',
          commitHash: 'old',
          createdAt: new Date(NOW.getTime() - 48 * HOUR).toISOString(),
        }),
        deployment({
          uuid: '{live}',
          releaseName: '#412',
          commitHash: 'live',
          createdAt: NOW.toISOString(),
        }),
      ]);

      const environments = await deployments.currentEnvironments(repositoryId);

      expect(environments).toHaveLength(1);
      expect(environments[0]).toMatchObject({
        environmentName: 'production',
        releaseName: '#412',
        commitHash: 'live',
      });
      expect(environments[0].deployedAt).toEqual(NOW);
    });

    it('orders environments the way releases are promoted', async () => {
      await deployments.replaceForRepository(repositoryId, [
        deployment({ uuid: '{p}', environmentName: 'production' }),
        deployment({
          uuid: '{t}',
          environmentName: 'dev',
          environmentType: 'Test',
        }),
        deployment({
          uuid: '{s}',
          environmentName: 'staging',
          environmentType: 'Staging',
        }),
      ]);

      const environments = await deployments.currentEnvironments(repositoryId);

      expect(environments.map(e => e.environmentName)).toEqual([
        'dev',
        'staging',
        'production',
      ]);
    });

    it('shows an environment of an unrecognised type last rather than hiding it', async () => {
      await deployments.replaceForRepository(repositoryId, [
        deployment({ uuid: '{p}' }),
        deployment({
          uuid: '{x}',
          environmentName: 'sandbox',
          environmentType: undefined,
        }),
      ]);

      const environments = await deployments.currentEnvironments(repositoryId);

      expect(environments.map(e => e.environmentName)).toEqual([
        'production',
        'sandbox',
      ]);
    });

    it('ignores a deployment that never completed', async () => {
      // An in-progress or rolled-back release is not what is running.
      await deployments.replaceForRepository(repositoryId, [
        deployment({
          uuid: '{live}',
          releaseName: '#412',
          createdAt: new Date(NOW.getTime() - HOUR).toISOString(),
        }),
        deployment({
          uuid: '{failed}',
          releaseName: '#413',
          state: 'UNDEPLOYED',
          createdAt: NOW.toISOString(),
        }),
      ]);

      const environments = await deployments.currentEnvironments(repositoryId);

      expect(environments).toHaveLength(1);
      expect(environments[0].releaseName).toBe('#412');
    });

    it('separates environments that differ only by case', async () => {
      // Bitbucket treats `dev` and `Dev` as two environments and so must we,
      // or one repository's history overwrites the other's.
      await deployments.replaceForRepository(repositoryId, [
        deployment({ uuid: '{a}', environmentName: 'Staging' }),
        deployment({ uuid: '{b}', environmentName: 'staging' }),
      ]);

      const environments = await deployments.currentEnvironments(repositoryId);

      expect(environments).toHaveLength(2);
    });
  });
});
