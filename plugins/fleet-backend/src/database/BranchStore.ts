import type { DatabaseService } from '@backstage/backend-plugin-api';
import type { BitbucketBranch } from '../bitbucket/types';

type DatabaseClient = Awaited<ReturnType<DatabaseService['getClient']>>;

export interface StaleBranch {
  name: string;
  lastCommitAt: Date | null;
}

export interface BranchSummary {
  total: number;
  /** Branches with a commit inside the staleness window. */
  active: number;
  stale: number;
}

/**
 * Branch snapshots.
 *
 * Replaced wholesale per repository rather than merged: a deleted branch must
 * disappear, and a branch has no history worth keeping once it is gone.
 */
export class BranchStore {
  constructor(private readonly db: DatabaseClient) {}

  async replaceForRepository(
    repositoryId: number,
    branches: BitbucketBranch[],
    defaultBranch?: string | null,
  ): Promise<number> {
    await this.db('branch').where({ repository_id: repositoryId }).delete();
    if (branches.length === 0) return 0;

    const rows = branches.map(branch => ({
      repository_id: repositoryId,
      name: branch.name,
      last_commit_at: branch.lastCommitAt
        ? new Date(branch.lastCommitAt)
        : null,
      last_commit_hash: branch.lastCommitHash ?? null,
      is_default: branch.name === defaultBranch,
    }));

    for (let i = 0; i < rows.length; i += 200) {
      await this.db('branch').insert(rows.slice(i, i + 200));
    }
    return rows.length;
  }

  async summary(
    repositoryId: number,
    staleBefore: Date,
  ): Promise<BranchSummary> {
    const rows = await this.db('branch')
      .where({ repository_id: repositoryId })
      .select('last_commit_at');

    let active = 0;
    for (const row of rows as Array<{ last_commit_at: Date | null }>) {
      const at = row.last_commit_at ? new Date(row.last_commit_at) : null;
      if (at && at.getTime() >= staleBefore.getTime()) active++;
    }

    return { total: rows.length, active, stale: rows.length - active };
  }

  /**
   * The branches abandoned longest ago, oldest first.
   *
   * Section 6 asks for long-running branches by name, not just a count: a
   * number tells someone there is a problem, the names tell them what to delete.
   */
  async stalest(
    repositoryId: number,
    staleBefore: Date,
    limit = 5,
  ): Promise<StaleBranch[]> {
    const rows = (await this.db('branch')
      .where({ repository_id: repositoryId, is_default: false })
      .where(builder =>
        builder
          .where('last_commit_at', '<', staleBefore)
          .orWhereNull('last_commit_at'),
      )
      .orderBy('last_commit_at', 'asc')
      .limit(limit)
      .select('name', 'last_commit_at')) as Array<{
      name: string;
      last_commit_at: Date | null;
    }>;

    return rows.map(row => ({
      name: row.name,
      lastCommitAt: row.last_commit_at ? new Date(row.last_commit_at) : null,
    }));
  }
}
