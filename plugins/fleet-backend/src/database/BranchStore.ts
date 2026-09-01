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

/** A branch the divergence pass should measure. */
export interface DivergenceCandidate {
  id: number;
  name: string;
}

export interface DivergenceSummary {
  /** Branches actually measured. Never assumes an unmeasured branch is clean. */
  measured: number;
  /** Of those, how many hold work that is not on the default branch. */
  diverged: number;
  /** Commits stranded across all measured branches. */
  commits: number;
  /** True when any branch hit the one-page cap, so `commits` is a floor. */
  capped: boolean;
  /** Worst first. */
  worst: Array<{ name: string; commits: number; capped: boolean }>;
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
    // Divergence is measured by a slower pass on its own schedule, and this
    // one runs every 30 minutes. Carrying it across the replace is what stops
    // every measurement being thrown away before anything can read it.
    const previous = (await this.db('branch')
      .where({ repository_id: repositoryId })
      .select(
        'name',
        'last_commit_hash',
        'diverged_commits',
        'is_capped',
        'diverged_checked_at',
      )) as Array<{
      name: string;
      last_commit_hash: string | null;
      diverged_commits: number | null;
      is_capped: boolean | number;
      diverged_checked_at: Date | null;
    }>;
    const carried = new Map(previous.map(row => [row.name, row]));

    await this.db('branch').where({ repository_id: repositoryId }).delete();
    if (branches.length === 0) return 0;

    const rows = branches.map(branch => {
      const before = carried.get(branch.name);
      const moved =
        before !== undefined &&
        (before.last_commit_hash ?? null) !== (branch.lastCommitHash ?? null);
      return {
        repository_id: repositoryId,
        name: branch.name,
        last_commit_at: branch.lastCommitAt
          ? new Date(branch.lastCommitAt)
          : null,
        last_commit_hash: branch.lastCommitHash ?? null,
        is_default: branch.name === defaultBranch,
        // A branch that has moved since it was measured is stale data, so the
        // figure is dropped rather than shown as current.
        diverged_commits: moved ? null : before?.diverged_commits ?? null,
        is_capped: moved ? false : Boolean(before?.is_capped),
        diverged_checked_at: moved ? null : before?.diverged_checked_at ?? null,
      };
    });

    for (let i = 0; i < rows.length; i += 200) {
      await this.db('branch').insert(rows.slice(i, i + 200));
    }
    return rows.length;
  }

  /**
   * Branches worth measuring for divergence.
   *
   * Skips the default branch, and skips any branch that is the source of a
   * **merged** pull request. That second filter is not an optimisation: 51% of
   * this estate's merged pull requests are squashed, and a squash leaves the
   * branch's original commits unreachable from the default branch for ever, so
   * `commits?exclude=main` reports shipped work as stranded. Two of eight
   * branches sampled on `oxp-frontend` were exactly this. 77 of 262 non-default
   * branches are filtered here, and the filter costs nothing -- `source_branch`
   * is already stored.
   */
  async branchesNeedingDivergence(
    repositoryId: number,
  ): Promise<DivergenceCandidate[]> {
    const rows = (await this.db('branch')
      .where({ repository_id: repositoryId, is_default: false })
      .whereNotExists(function mergedPullRequestForBranch() {
        this.select('*')
          .from('pull_request')
          .whereRaw('pull_request.repository_id = branch.repository_id')
          .andWhereRaw('pull_request.source_branch = branch.name')
          .andWhere('pull_request.state', 'MERGED');
      })
      .orderBy('name', 'asc')
      .select('id', 'name')) as Array<{ id: number; name: string }>;

    return rows.map(row => ({ id: Number(row.id), name: row.name }));
  }

  /** Records one measurement. `capped` means the real figure is higher. */
  async recordDivergence(
    branchId: number,
    divergence: { commits: number; capped: boolean },
    checkedAt: Date,
  ): Promise<void> {
    await this.db('branch').where({ id: branchId }).update({
      diverged_commits: divergence.commits,
      is_capped: divergence.capped,
      diverged_checked_at: checkedAt,
    });
  }

  /**
   * Stranded work across a repository's branches.
   *
   * `measured` is reported separately from `diverged` on purpose: a repository
   * whose branches have never been checked has an unknown amount of stranded
   * work, which is not the same as none.
   */
  async divergenceSummary(
    repositoryId: number,
    worstLimit = 3,
  ): Promise<DivergenceSummary> {
    const rows = (await this.db('branch')
      .where({ repository_id: repositoryId, is_default: false })
      .whereNotNull('diverged_commits')
      .select('name', 'diverged_commits', 'is_capped')) as Array<{
      name: string;
      diverged_commits: number;
      is_capped: boolean | number;
    }>;

    const measured = rows.map(row => ({
      name: row.name,
      commits: Number(row.diverged_commits),
      capped: Boolean(row.is_capped),
    }));
    const diverged = measured.filter(row => row.commits > 0);

    return {
      measured: measured.length,
      diverged: diverged.length,
      commits: diverged.reduce((sum, row) => sum + row.commits, 0),
      capped: diverged.some(row => row.capped),
      worst: [...diverged]
        .sort((a, b) => b.commits - a.commits || a.name.localeCompare(b.name))
        .slice(0, worstLimit),
    };
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
