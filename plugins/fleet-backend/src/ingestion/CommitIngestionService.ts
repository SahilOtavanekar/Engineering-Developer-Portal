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
  /**
   * How far back a first-time ingestion reaches, in days.
   *
   * Undefined means all of it, which is the default: measured across this
   * estate, full history is ~18,700 commits in ~344 requests, and only on the
   * first pass. Set a number to bound the backfill instead.
   */
  windowDays?: number;
}

export interface CommitIngestionSummary {
  repositories: number;
  commitsWritten: number;
  /** Repositories reaching back past any window, i.e. a full backfill. */
  backfilled: number;
  failures: number;
  requests: number;
}

/**
 * Ingests commits for every live repository in a workspace.
 *
 * Incremental by construction: each repository already knows its newest commit,
 * so subsequent passes ask Bitbucket only for what came after it.
 *
 * The first pass reaches back through **all** history by default. That was
 * originally bounded to 90 days on the assumption that unbounded backfill would
 * eat the API quota, but measurement disproved it: the whole estate is roughly
 * 18,700 commits in 344 requests, paid once. Bounding it instead cost the
 * portal the ability to tell an abandoned service from a repository somebody
 * created and pushed to twice -- `chat-widget` has two commits in its entire
 * life, and looked identical to a mature project gone quiet.
 *
 * Every metric windows explicitly at its own boundary
 * ({@link CommitStore.activitySince} and friends), so deeper history changes no
 * score. It is purely additive.
 */
export class CommitIngestionService {
  private readonly client: BitbucketClient;
  private readonly repositories: RepositoryStore;
  private readonly commits: CommitStore;
  private readonly syncState: SyncStateStore;
  private readonly logger: LoggerService;
  private readonly windowDays?: number;

  constructor(options: CommitIngestionServiceOptions) {
    this.client = options.client;
    this.repositories = options.repositories;
    this.commits = options.commits;
    this.syncState = options.syncState;
    this.logger = options.logger;
    this.windowDays = options.windowDays;
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
    const windowStart =
      this.windowDays === undefined
        ? undefined
        : new Date(now.getTime() - this.windowDays * 24 * 60 * 60 * 1000);

    let commitsWritten = 0;
    let backfilled = 0;
    let failures = 0;

    try {
      const live = await this.repositories.listLive(workspace);

      for (const repository of live) {
        try {
          // Resume from the newest commit already stored. With nothing stored
          // this is a backfill, reaching as far as `windowDays` allows -- all
          // the way, unless one was configured.
          const known = await this.commits.latestCommitAt(repository.id);
          const since = known ?? windowStart;
          if (!known) backfilled++;

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
        backfilled,
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

      const backfill =
        summary.backfilled > 0
          ? `, ${summary.backfilled} backfilled from scratch`
          : '';
      this.logger.info(
        `Commit sync for '${workspace}': ${summary.commitsWritten} new commits ` +
          `across ${summary.repositories} repositories${backfill} ` +
          `(${summary.failures} failed) using ${summary.requests} API request(s)`,
      );
      return summary;
    } catch (error) {
      await this.syncState.recordFailure(resource, error as Error, now);
      throw error;
    }
  }
}
