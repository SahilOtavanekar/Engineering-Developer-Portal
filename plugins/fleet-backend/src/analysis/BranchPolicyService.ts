import type { LoggerService } from '@backstage/backend-plugin-api';
import type { CommitStore } from '../database/CommitStore';
import type { PullRequestStore } from '../database/PullRequestStore';
import type { RepositoryStore } from '../database/RepositoryStore';
import type { SyncStateStore } from '../database/SyncStateStore';
import { classifyArrivals } from './branchPolicy';

export interface BranchPolicyServiceOptions {
  repositories: RepositoryStore;
  commits: CommitStore;
  pullRequests: PullRequestStore;
  syncState: SyncStateStore;
  logger: LoggerService;
}

export interface BranchPolicySweepSummary {
  repositories: number;
  classified: number;
  /** Repositories with no parent hashes stored, so nothing could be decided. */
  skippedNoParents: number;
  /** Repositories with no default branch recorded. */
  skippedNoBranch: number;
  /**
   * Repositories with merged pull requests but no merge hashes stored, so
   * nothing could be decided without reporting every commit as direct.
   */
  skippedNoMergeHashes: number;
  failures: number;
}

/**
 * Works out how every stored commit reached its repository's default branch.
 *
 * Costs no Bitbucket requests at all: the parent hashes and the pull request
 * merge hashes are both already stored, having been fetched for other reasons.
 * That is why this runs as its own pass rather than inside ingestion -- it can
 * be re-run freely, and a change to the classification rule needs no refetch.
 *
 * Repositories whose commits predate the parent-hash column are skipped rather
 * than misreported: without parents there is no first-parent chain, and
 * treating every commit as mainline would overstate direct commits threefold.
 */
export class BranchPolicyService {
  private readonly repositories: RepositoryStore;
  private readonly commits: CommitStore;
  private readonly pullRequests: PullRequestStore;
  private readonly syncState: SyncStateStore;
  private readonly logger: LoggerService;

  constructor(options: BranchPolicyServiceOptions) {
    this.repositories = options.repositories;
    this.commits = options.commits;
    this.pullRequests = options.pullRequests;
    this.syncState = options.syncState;
    this.logger = options.logger;
  }

  static resourceKey(workspace: string): string {
    return `branch-policy:${workspace}`;
  }

  async classifyAll(
    workspace: string,
    now: Date = new Date(),
  ): Promise<BranchPolicySweepSummary> {
    const resource = BranchPolicyService.resourceKey(workspace);
    await this.syncState.recordAttempt(resource, now);

    let classified = 0;
    let skippedNoParents = 0;
    let skippedNoBranch = 0;
    let skippedNoMergeHashes = 0;
    let failures = 0;

    try {
      const live = await this.repositories.listLive(workspace);

      for (const repository of live) {
        try {
          if (!repository.default_branch) {
            skippedNoBranch++;
            continue;
          }
          // Partial parent data is worse than none: the walk stops at the
          // first commit without parents and understates the mainline.
          if ((await this.commits.commitsMissingParents(repository.id)) > 0) {
            skippedNoParents++;
            continue;
          }

          // A repository with merged pull requests but no merge hashes cannot
          // be judged: matching against an empty list does not fail, it reports
          // every commit as direct. A repository with no pull requests at all is
          // a different thing -- everything there really is direct.
          const coverage = await this.pullRequests.mergeHashCoverage(
            repository.id,
            repository.default_branch,
          );
          if (coverage.merged > 0 && coverage.withHash === 0) {
            skippedNoMergeHashes++;
            continue;
          }

          const [graph, merges] = await Promise.all([
            this.commits.graph(repository.id),
            this.pullRequests.mergeHashesForBranch(
              repository.id,
              repository.default_branch,
            ),
          ]);

          const result = classifyArrivals({
            commits: graph,
            pullRequestMerges: merges,
          });
          classified += await this.commits.recordArrivals(
            repository.id,
            result,
          );
        } catch (error) {
          failures++;
          this.logger.warn(
            `Branch policy classification failed for '${workspace}/${
              repository.slug
            }': ${(error as Error).message}`,
          );
        }
      }

      const summary: BranchPolicySweepSummary = {
        repositories: live.length,
        classified,
        skippedNoParents,
        skippedNoBranch,
        skippedNoMergeHashes,
        failures,
      };

      if (failures === 0) {
        await this.syncState.recordSuccess(resource, {
          cursor: now.toISOString(),
          now,
        });
      } else {
        await this.syncState.recordFailure(
          resource,
          new Error(`${failures} repositories failed`),
          now,
        );
      }

      this.logger.info(
        `Branch policy for '${workspace}': classified ${classified} commits ` +
          `across ${summary.repositories} repositories ` +
          `(${skippedNoParents} awaiting parent hashes, ` +
          `${skippedNoBranch} with no default branch, ${failures} failed)`,
      );
      return summary;
    } catch (error) {
      await this.syncState.recordFailure(resource, error as Error, now);
      throw error;
    }
  }
}
