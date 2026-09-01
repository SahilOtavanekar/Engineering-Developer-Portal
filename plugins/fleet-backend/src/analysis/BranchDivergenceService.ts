import type { LoggerService } from '@backstage/backend-plugin-api';
import type { BitbucketClient } from '../bitbucket/types';
import type { BranchStore } from '../database/BranchStore';
import type { RepositoryStore } from '../database/RepositoryStore';
import type { SyncStateStore } from '../database/SyncStateStore';

export interface BranchDivergenceServiceOptions {
  repositories: RepositoryStore;
  branches: BranchStore;
  syncState: SyncStateStore;
  client: BitbucketClient;
  logger: LoggerService;
  /**
   * Ceiling on requests for one sweep.
   *
   * The estate needs about 185 today. The cap is what stops a workspace that
   * grows a thousand branches from quietly turning a background pass into the
   * dominant consumer of the API budget.
   */
  requestBudget?: number;
}

export interface BranchDivergenceSweepSummary {
  repositories: number;
  /** Branches actually asked about. */
  measured: number;
  /** Branches holding work that is not on the default branch. */
  diverged: number;
  /** Skipped because the repository records no default branch. */
  skippedNoDefaultBranch: number;
  /** Left unmeasured because the request budget ran out. */
  skippedOverBudget: number;
  failures: number;
}

export const DEFAULT_REQUEST_BUDGET = 400;

/**
 * How much work is sitting on branches that never reached the default branch.
 *
 * The one thing about branches the portal could not answer. `branchHygiene`
 * measures whether a branch was *touched* recently, which says nothing about
 * how much is stranded on it -- a branch abandoned yesterday with 90 commits
 * on it and one abandoned yesterday with none score identically.
 *
 * **Its own pass, on its own schedule, because it is the only thing here that
 * costs a request per branch.** Everything else in the portal is a request per
 * repository or fewer. Divergence also barely moves: a branch that is 40
 * commits adrift this morning is 40 adrift this afternoon, so measuring it
 * every 30 minutes alongside the other passes would spend the estate's entire
 * request budget to learn nothing.
 *
 * Two things it deliberately does not do:
 *
 * - **It does not measure branches with a merged pull request.** A squash
 *   merge leaves the branch's commits unreachable from the default branch for
 *   ever, so those branches read as fully diverged when their work has shipped.
 *   51% of this estate's merged pull requests are squashed.
 * - **It does not treat unmeasured as clean.** A branch that has never been
 *   checked, or one that moved since it was, reports nothing rather than zero.
 */
export class BranchDivergenceService {
  private readonly repositories: RepositoryStore;
  private readonly branches: BranchStore;
  private readonly syncState: SyncStateStore;
  private readonly client: BitbucketClient;
  private readonly logger: LoggerService;
  private readonly requestBudget: number;

  constructor(options: BranchDivergenceServiceOptions) {
    this.repositories = options.repositories;
    this.branches = options.branches;
    this.syncState = options.syncState;
    this.client = options.client;
    this.logger = options.logger;
    this.requestBudget = options.requestBudget ?? DEFAULT_REQUEST_BUDGET;
  }

  static resourceKey(workspace: string): string {
    return `branch-divergence:${workspace}`;
  }

  async measureAll(workspace: string): Promise<BranchDivergenceSweepSummary> {
    const records = await this.repositories.listLive(workspace);
    const summary: BranchDivergenceSweepSummary = {
      repositories: 0,
      measured: 0,
      diverged: 0,
      skippedNoDefaultBranch: 0,
      skippedOverBudget: 0,
      failures: 0,
    };

    let spent = 0;
    const checkedAt = new Date();

    for (const record of records) {
      if (!record.default_branch) {
        summary.skippedNoDefaultBranch++;
        continue;
      }

      const candidates = await this.branches.branchesNeedingDivergence(
        record.id,
      );
      if (candidates.length === 0) continue;
      summary.repositories++;

      for (const candidate of candidates) {
        if (spent >= this.requestBudget) {
          summary.skippedOverBudget++;
          continue;
        }

        try {
          spent++;
          const divergence = await this.client.countCommitsAhead(
            record.workspace,
            record.slug,
            candidate.name,
            record.default_branch,
          );
          await this.branches.recordDivergence(
            candidate.id,
            divergence,
            checkedAt,
          );
          summary.measured++;
          if (divergence.commits > 0) summary.diverged++;
        } catch (error) {
          // One unreachable branch must not abandon the estate: a branch can
          // be deleted between the listing and the measurement, and that is
          // ordinary rather than exceptional.
          summary.failures++;
          this.logger.warn(
            `Could not measure divergence for ${record.slug}#${candidate.name}`,
            error instanceof Error ? error : undefined,
          );
        }
      }
    }

    await this.syncState.recordSuccess(
      BranchDivergenceService.resourceKey(workspace),
      { now: checkedAt },
    );

    this.logger.info(
      `Branch divergence: measured ${summary.measured} branches across ` +
        `${summary.repositories} repositories, ${summary.diverged} holding ` +
        `unmerged work (${spent} requests, ${summary.failures} failures` +
        `${
          summary.skippedOverBudget > 0
            ? `, ${summary.skippedOverBudget} left for the next pass`
            : ''
        })`,
    );

    return summary;
  }
}
