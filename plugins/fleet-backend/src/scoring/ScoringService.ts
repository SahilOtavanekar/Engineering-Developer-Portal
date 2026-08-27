import type { LoggerService } from '@backstage/backend-plugin-api';
import type { BranchStore } from '../database/BranchStore';
import type { CommitStore } from '../database/CommitStore';
import type { PipelineStore } from '../database/PipelineStore';
import type { OwnershipStore } from '../database/OwnershipStore';
import type { PullRequestStore } from '../database/PullRequestStore';
import type { RepositoryStore } from '../database/RepositoryStore';
import type { ScoreStore } from '../database/ScoreStore';
import type { SyncStateStore } from '../database/SyncStateStore';
import type { ScoringEngine } from './ScoringEngine';
import { OwnershipService } from '../ownership/OwnershipService';
import { DEFAULT_DISCIPLINE_WINDOW_DAYS } from './scorers/pullRequestDiscipline';

export interface ScoringServiceOptions {
  engine: ScoringEngine;
  repositories: RepositoryStore;
  commits: CommitStore;
  branches: BranchStore;
  pipelines: PipelineStore;
  pullRequests: PullRequestStore;
  /**
   * Read to score the ownership metric. Required rather than optional: it lives
   * in the same database as everything else here, so if it is unreachable so is
   * the rest of the pass.
   */
  ownership: OwnershipStore;
  scores: ScoreStore;
  syncState: SyncStateStore;
  logger: LoggerService;
  windowDays?: number;
  /** Window for the pull-request discipline metric. Defaults to 30 days. */
  disciplineWindowDays?: number;
}

export interface ScoringSummary {
  scored: number;
  failures: number;
  bands: Record<string, number>;
}

const DEFAULT_WINDOW_DAYS = 90;

/**
 * Scores every live repository on a schedule and appends the result.
 *
 * Scores are computed here, never during a page render: assembling one means
 * aggregating commits, and doing that per row in a fleet-wide listing is
 * exactly what the two-second load requirement cannot afford.
 */
export class ScoringService {
  private readonly engine: ScoringEngine;
  private readonly repositories: RepositoryStore;
  private readonly commits: CommitStore;
  private readonly branches: BranchStore;
  private readonly pipelines: PipelineStore;
  private readonly pullRequests: PullRequestStore;
  private readonly ownership: OwnershipStore;
  private readonly scores: ScoreStore;
  private readonly syncState: SyncStateStore;
  private readonly logger: LoggerService;
  private readonly windowDays: number;
  private readonly disciplineWindowDays: number;

  constructor(options: ScoringServiceOptions) {
    this.engine = options.engine;
    this.repositories = options.repositories;
    this.commits = options.commits;
    this.branches = options.branches;
    this.pipelines = options.pipelines;
    this.pullRequests = options.pullRequests;
    this.ownership = options.ownership;
    this.scores = options.scores;
    this.syncState = options.syncState;
    this.logger = options.logger;
    this.windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS;
    this.disciplineWindowDays =
      options.disciplineWindowDays ?? DEFAULT_DISCIPLINE_WINDOW_DAYS;
  }

  static resourceKey(workspace: string): string {
    return `scoring:${workspace}`;
  }

  async scoreAll(
    workspace: string,
    now: Date = new Date(),
  ): Promise<ScoringSummary> {
    const resource = ScoringService.resourceKey(workspace);
    await this.syncState.recordAttempt(resource, now);

    const since = new Date(
      now.getTime() - this.windowDays * 24 * 60 * 60 * 1000,
    );
    const disciplineSince = new Date(
      now.getTime() - this.disciplineWindowDays * 24 * 60 * 60 * 1000,
    );
    const bands: Record<string, number> = {};
    let scored = 0;
    let failures = 0;

    try {
      const live = await this.repositories.listLive(workspace);

      // Two queries for the whole estate, not two per repository. A lookup
      // inside the loop would be an N+1 that is invisible at 95 repositories
      // and ruinous at the 10,000 the document imagines.
      //
      // The sync state is what separates "nobody owns this" from "ownership has
      // never been resolved": a repository with no owner stores no candidate
      // rows, so the rows alone cannot tell the two apart, and scoring the
      // second case zero would misreport every repository on a first boot.
      const ownershipState = await this.syncState.get(
        OwnershipService.resourceKey(workspace),
      );
      const ownershipResolved = Boolean(ownershipState?.last_success_at);
      const proposedOwners = ownershipResolved
        ? await this.ownership.proposedForRepositories(live.map(r => r.id))
        : new Map();

      if (!ownershipResolved) {
        this.logger.info(
          `Ownership has never resolved for '${workspace}'; the owner-assigned ` +
            `metric will report as unmeasured rather than as zero`,
        );
      }

      for (const repository of live) {
        try {
          const [activity, branches, pipelines, reviews, policy] =
            await Promise.all([
              this.commits.activitySince(repository.id, since),
              this.branches.summary(repository.id, since),
              this.pipelines.summary(repository.id),
              this.pullRequests.reviewSummary(repository.id, since),
              // Its own window: direct commits collapsed around 2026-07-27, so
              // the activity window would mostly report behaviour that has
              // already changed.
              this.commits.branchPolicySince(repository.id, disciplineSince),
            ]);

          const score = this.engine.score({
            repository,
            activity,
            branches,
            pipelines,
            reviews,
            ownership: ownershipResolved
              ? { proposed: proposedOwners.get(repository.id) }
              : undefined,
            // `classified: 0` means the pass has not reached this repository,
            // which is unmeasurable. A repository it reached but where nothing
            // landed is present with `mainline: 0`, which is measurable.
            branchPolicy:
              policy.classified > 0
                ? { ...policy, branch: repository.default_branch ?? undefined }
                : undefined,
            windowDays: this.windowDays,
            now,
          });

          await this.scores.record(repository.id, score, now);
          bands[score.band] = (bands[score.band] ?? 0) + 1;
          scored++;
        } catch (error) {
          failures++;
          this.logger.warn(
            `Scoring failed for '${workspace}/${repository.slug}': ${
              (error as Error).message
            }`,
          );
        }
      }

      if (failures === 0) {
        await this.syncState.recordSuccess(resource, {
          cursor: now.toISOString(),
          now,
        });
      } else {
        await this.syncState.recordFailure(
          resource,
          new Error(`${failures} repositories failed to score`),
          now,
        );
      }

      this.logger.info(
        `Scored ${scored} repositories in '${workspace}' ` +
          `(${Object.entries(bands)
            .map(([band, n]) => `${n} ${band}`)
            .join(', ')})`,
      );
      return { scored, failures, bands };
    } catch (error) {
      await this.syncState.recordFailure(resource, error as Error, now);
      throw error;
    }
  }
}
