import type { LoggerService } from '@backstage/backend-plugin-api';
import type { BitbucketClient } from '../bitbucket/types';
import type { RepositoryStore, SyncSummary } from '../database/RepositoryStore';
import type { SyncStateStore } from '../database/SyncStateStore';

export interface RepositoryIngestionServiceOptions {
  client: BitbucketClient;
  repositories: RepositoryStore;
  syncState: SyncStateStore;
  logger: LoggerService;
}

/**
 * Fetches a Bitbucket workspace and persists it as repository facts.
 *
 * Separate from the catalog entity provider on purpose. The provider owns
 * catalog entities -- identity and ownership -- while this owns the fact store
 * that scoring reads from. Both call the same client; at 95 repositories the
 * duplicated listing costs one extra request per cycle, which is a fair price
 * for keeping the two concerns independent.
 */
export class RepositoryIngestionService {
  private readonly client: BitbucketClient;
  private readonly repositories: RepositoryStore;
  private readonly syncState: SyncStateStore;
  private readonly logger: LoggerService;

  constructor(options: RepositoryIngestionServiceOptions) {
    this.client = options.client;
    this.repositories = options.repositories;
    this.syncState = options.syncState;
    this.logger = options.logger;
  }

  static resourceKey(workspace: string): string {
    return `repositories:${workspace}`;
  }

  /**
   * Runs one synchronisation pass.
   *
   * Failures are recorded and rethrown -- the caller decides whether to let a
   * scheduled task die or carry on to the next tick.
   */
  async ingest(
    workspace: string,
    now: Date = new Date(),
  ): Promise<SyncSummary> {
    const resource = RepositoryIngestionService.resourceKey(workspace);
    await this.syncState.recordAttempt(resource, now);

    try {
      const before = this.client.requestCount;
      const repositories = await this.client.listRepositories(workspace);
      const summary = await this.repositories.syncWorkspace(
        workspace,
        repositories,
        now,
      );

      await this.syncState.recordSuccess(resource, {
        cursor: now.toISOString(),
        now,
      });

      this.logger.info(
        `Repository sync for '${workspace}': ${summary.live} live ` +
          `(${summary.inserted} new, ${summary.updated} updated, ${summary.removed} removed) ` +
          `using ${this.client.requestCount - before} API request(s)`,
      );
      return summary;
    } catch (error) {
      await this.syncState.recordFailure(resource, error as Error, now);
      throw error;
    }
  }
}
