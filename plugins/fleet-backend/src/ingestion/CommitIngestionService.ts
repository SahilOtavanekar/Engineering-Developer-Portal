import type { LoggerService } from '@backstage/backend-plugin-api';
import type { BitbucketClient } from '../bitbucket/types';
import type { CommitStore } from '../database/CommitStore';
import type { RepositoryStore } from '../database/RepositoryStore';
import type { SyncStateStore } from '../database/SyncStateStore';

export interface CommitIngestionServiceOptions {
  client: BitbucketClient;
  repositories: RepositoryStore;
  commits: CommitStore;
  syncState: SyncStateStore;
  logger: LoggerService;
  /** How far back a first-time ingestion reaches. Defaults to 90 days. */
  windowDays?: number;
}

export interface CommitIngestionSummary {
  repositories: number;
  commitsWritten: number;
  failures: number;
  requests: number;
}

const DEFAULT_WINDOW_DAYS = 90;

/**
 * Ingests commits for every live repository in a workspace.
 *
 * Incremental by construction: each repository already knows its newest commit,
 * so subsequent passes ask Bitbucket only for what came after it. The first
 * pass is bounded by a window rather than reaching back through all history,
 * because unbounded backfill is how an ingestion job eats an API quota.
 */
export class CommitIngestionService {
  private readonly client: BitbucketClient;
  private readonly repositories: RepositoryStore;
  private readonly commits: CommitStore;
  private readonly syncState: SyncStateStore;
  private readonly logger: LoggerService;
  private readonly windowDays: number;

  constructor(options: CommitIngestionServiceOptions) {
    this.client = options.client;
    this.repositories = options.repositories;
    this.commits = options.commits;
    this.syncState = options.syncState;
    this.logger = options.logger;
    this.windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS;
  }

  static resourceKey(workspace: string): string {
    return `commits:${workspace}`;
  }

  async ingest(
    workspace: string,
    now: Date = new Date(),
  ): Promise<CommitIngestionSummary> {
    const resource = CommitIngestionService.resourceKey(workspace);
    await this.syncState.recordAttempt(resource, now);

    const startedRequests = this.client.requestCount;
    const windowStart = new Date(
      now.getTime() - this.windowDays * 24 * 60 * 60 * 1000,
    );

    let commitsWritten = 0;
    let failures = 0;

    try {
      const live = await this.repositories.listLive(workspace);

      for (const repository of live) {
        try {
          // Resume from the newest commit already stored; otherwise take the
          // bounded first-run window.
          const known = await this.commits.latestCommitAt(repository.id);
          const since = known ?? windowStart;

          const fetched = await this.client.listCommits(
            workspace,
            repository.slug,
            { since, branch: repository.default_branch ?? undefined },
          );

          if (fetched.length > 0) {
            commitsWritten += await this.commits.insertMany(
              repository.id,
              fetched,
            );
            await this.repositories.setLastCommitAt(
              repository.id,
              new Date(fetched[0].committedAt),
            );
          } else if (known) {
            await this.repositories.setLastCommitAt(repository.id, known);
          }
        } catch (error) {
          // One unreachable repository must not abandon the other 94.
          failures++;
          this.logger.warn(
            `Commit ingestion failed for '${workspace}/${repository.slug}': ${
              (error as Error).message
            }`,
          );
        }
      }

      const summary: CommitIngestionSummary = {
        repositories: live.length,
        commitsWritten,
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
        `Commit sync for '${workspace}': ${summary.commitsWritten} new commits ` +
          `across ${summary.repositories} repositories ` +
          `(${summary.failures} failed) using ${summary.requests} API request(s)`,
      );
      return summary;
    } catch (error) {
      await this.syncState.recordFailure(resource, error as Error, now);
      throw error;
    }
  }
}
