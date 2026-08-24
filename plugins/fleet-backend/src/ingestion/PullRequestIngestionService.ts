import type { LoggerService } from '@backstage/backend-plugin-api';
import type { BitbucketClient } from '../bitbucket/types';
import type { PullRequestStore } from '../database/PullRequestStore';
import type { RepositoryStore } from '../database/RepositoryStore';
import type { SyncStateStore } from '../database/SyncStateStore';

export interface PullRequestIngestionServiceOptions {
  client: BitbucketClient;
  repositories: RepositoryStore;
  pullRequests: PullRequestStore;
  syncState: SyncStateStore;
  logger: LoggerService;
  /** How far back a first-time pass reaches. Defaults to 90 days. */
  windowDays?: number;
}

export interface PullRequestIngestionSummary {
  repositories: number;
  pullRequestsWritten: number;
  failures: number;
  requests: number;
}

const DEFAULT_WINDOW_DAYS = 90;

/**
 * Ingests pull requests for every live repository.
 *
 * Incremental on `updated_on`: each repository resumes from the newest update
 * already stored. Open pull requests are therefore re-read whenever they change,
 * which is what keeps their approval counts current without a full re-scan.
 */
export class PullRequestIngestionService {
  private readonly client: BitbucketClient;
  private readonly repositories: RepositoryStore;
  private readonly pullRequests: PullRequestStore;
  private readonly syncState: SyncStateStore;
  private readonly logger: LoggerService;
  private readonly windowDays: number;

  constructor(options: PullRequestIngestionServiceOptions) {
    this.client = options.client;
    this.repositories = options.repositories;
    this.pullRequests = options.pullRequests;
    this.syncState = options.syncState;
    this.logger = options.logger;
    this.windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS;
  }

  static resourceKey(workspace: string): string {
    return `pull-requests:${workspace}`;
  }

  async ingest(
    workspace: string,
    now: Date = new Date(),
  ): Promise<PullRequestIngestionSummary> {
    const resource = PullRequestIngestionService.resourceKey(workspace);
    await this.syncState.recordAttempt(resource, now);

    const startedRequests = this.client.requestCount;
    const windowStart = new Date(
      now.getTime() - this.windowDays * 24 * 60 * 60 * 1000,
    );

    let written = 0;
    let failures = 0;

    try {
      const live = await this.repositories.listLive(workspace);

      for (const repository of live) {
        try {
          const known = await this.pullRequests.latestUpdatedAt(repository.id);
          const since = known ?? windowStart;

          const fetched = await this.client.listPullRequests(
            workspace,
            repository.slug,
            { since },
          );
          written += await this.pullRequests.upsertMany(repository.id, fetched);
        } catch (error) {
          failures++;
          this.logger.warn(
            `Pull request ingestion failed for '${workspace}/${
              repository.slug
            }': ${(error as Error).message}`,
          );
        }
      }

      const summary: PullRequestIngestionSummary = {
        repositories: live.length,
        pullRequestsWritten: written,
        failures,
        requests: this.client.requestCount - startedRequests,
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
        `Pull request sync for '${workspace}': ${summary.pullRequestsWritten} ` +
          `written across ${summary.repositories} repositories ` +
          `(${summary.failures} failed) using ${summary.requests} request(s)`,
      );
      return summary;
    } catch (error) {
      await this.syncState.recordFailure(resource, error as Error, now);
      throw error;
    }
  }
}
