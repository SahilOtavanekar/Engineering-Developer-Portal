import type { DatabaseService } from '@backstage/backend-plugin-api';
import type { BitbucketDeployment } from '../bitbucket/types';

type DatabaseClient = Awaited<ReturnType<DatabaseService['getClient']>>;

export interface EnvironmentState {
  environmentName: string;
  environmentType?: string;
  state: string;
  releaseName?: string;
  commitHash?: string;
  deployedAt: Date;
}

/**
 * Ordering of Bitbucket's environment types, which is the order things are
 * promoted through. Anything unrecognised sorts last rather than being hidden.
 */
const TYPE_ORDER: Record<string, number> = {
  Test: 0,
  Staging: 1,
  Production: 2,
};

const CHUNK = 200;

/** Deployment snapshots, replaced per repository on each pass. */
export class DeploymentStore {
  constructor(private readonly db: DatabaseClient) {}

  async replaceForRepository(
    repositoryId: number,
    deployments: BitbucketDeployment[],
  ): Promise<number> {
    await this.db('deployment').where({ repository_id: repositoryId }).delete();
    if (deployments.length === 0) return 0;

    const rows = deployments.map(deployment => ({
      repository_id: repositoryId,
      uuid: deployment.uuid,
      number: deployment.number ?? null,
      environment_name: deployment.environmentName,
      environment_type: deployment.environmentType ?? null,
      state: deployment.state,
      release_name: deployment.releaseName ?? null,
      commit_hash: deployment.commitHash ?? null,
      created_at: new Date(deployment.createdAt),
      last_updated_at: deployment.lastUpdatedAt
        ? new Date(deployment.lastUpdatedAt)
        : null,
    }));

    for (let i = 0; i < rows.length; i += CHUNK) {
      await this.db('deployment').insert(rows.slice(i, i + CHUNK));
    }
    return rows.length;
  }

  /**
   * What is currently live in each environment.
   *
   * The newest record per environment name wins. Records that never completed
   * are excluded: an in-progress or undeployed release is not what is running.
   */
  async currentEnvironments(repositoryId: number): Promise<EnvironmentState[]> {
    const rows = (await this.db('deployment')
      .where({ repository_id: repositoryId, state: 'COMPLETED' })
      .orderBy('created_at', 'desc')
      .select(
        'environment_name',
        'environment_type',
        'state',
        'release_name',
        'commit_hash',
        'created_at',
      )) as Array<{
      environment_name: string;
      environment_type: string | null;
      state: string;
      release_name: string | null;
      commit_hash: string | null;
      created_at: Date;
    }>;

    const latest = new Map<string, EnvironmentState>();
    for (const row of rows) {
      // Rows arrive newest first, so the first sighting of an environment is
      // the one that is live.
      if (latest.has(row.environment_name)) continue;
      latest.set(row.environment_name, {
        environmentName: row.environment_name,
        environmentType: row.environment_type ?? undefined,
        state: row.state,
        releaseName: row.release_name ?? undefined,
        commitHash: row.commit_hash ?? undefined,
        deployedAt: new Date(row.created_at),
      });
    }

    return [...latest.values()].sort((a, b) => {
      const byType =
        (TYPE_ORDER[a.environmentType ?? ''] ?? 99) -
        (TYPE_ORDER[b.environmentType ?? ''] ?? 99);
      return byType || a.environmentName.localeCompare(b.environmentName);
    });
  }

  /**
   * Which environment types each repository currently deploys to, keyed by id.
   *
   * Types rather than names: `dev`, `Dev` and `development` are three spellings
   * of one idea, and Bitbucket already classifies every record as Test,
   * Staging or Production. A search facet built on the free-text names would
   * offer the reader all three spellings as separate choices.
   */
  async environmentTypesForRepositories(
    repositoryIds: number[],
  ): Promise<Map<number, string[]>> {
    if (repositoryIds.length === 0) return new Map();

    const rows = (await this.db('deployment')
      .whereIn('repository_id', repositoryIds)
      .where({ state: 'COMPLETED' })
      .whereNotNull('environment_type')
      .distinct('repository_id', 'environment_type')) as Array<{
      repository_id: number;
      environment_type: string;
    }>;

    const byRepository = new Map<number, string[]>();
    for (const row of rows) {
      const id = Number(row.repository_id);
      const types = byRepository.get(id) ?? [];
      types.push(row.environment_type);
      byRepository.set(id, types);
    }
    // Promotion order, so a reader sees dev before production.
    for (const types of byRepository.values()) {
      types.sort((a, b) => (TYPE_ORDER[a] ?? 99) - (TYPE_ORDER[b] ?? 99));
    }
    return byRepository;
  }

  async count(repositoryId: number): Promise<number> {
    const row = await this.db('deployment')
      .where({ repository_id: repositoryId })
      .count({ n: '*' })
      .first();
    return Number((row as any)?.n ?? 0);
  }
}
