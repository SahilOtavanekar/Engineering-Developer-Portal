import type { LoggerService } from '@backstage/backend-plugin-api';
import type { BranchStore } from '../database/BranchStore';
import type { CommitStore } from '../database/CommitStore';
import type { PipelineStore } from '../database/PipelineStore';
import type { PullRequestStore } from '../database/PullRequestStore';
import type { RepositoryStore } from '../database/RepositoryStore';
import type { ScoreStore } from '../database/ScoreStore';
import type { SyncStateStore } from '../database/SyncStateStore';
import type { ScoringEngine } from './ScoringEngine';

export interface ScoringServiceOptions {
  engine: ScoringEngine;
  repositories: RepositoryStore;
  commits: CommitStore;
  branches: BranchStore;
  pipelines: PipelineStore;
  pullRequests: PullRequestStore;
  scores: ScoreStore;
  syncState: SyncStateStore;
  logger: LoggerService;
  windowDays?: number;
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
  private readonly scores: ScoreStore;
  private readonly syncState: SyncStateStore;
  private readonly logger: LoggerService;
  private readonly windowDays: number;

  constructor(options: ScoringServiceOptions) {
    this.engine = options.engine;
    this.repositories = options.repositories;
    this.commits = options.commits;
    this.branches = options.branches;
    this.pipelines = options.pipelines;
    this.pullRequests = options.pullRequests;
    this.scores = options.scores;
    this.syncState = options.syncState;
    this.logger = options.logger;
    this.windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS;
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
    const bands: Record<string, number> = {};
    let scored = 0;
    let failures = 0;

    try {
      const live = await this.repositories.listLive(workspace);

      for (const repository of live) {
        try {
          const [activity, branches, pipelines, reviews] = await Promise.all([
            this.commits.activitySince(repository.id, since),
            this.branches.summary(repository.id, since),
            this.pipelines.summary(repository.id),
            this.pullRequests.reviewSummary(repository.id, since),
          ]);

          const score = this.engine.score({
            repository,
            activity,
            branches,
            pipelines,
            reviews,
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
