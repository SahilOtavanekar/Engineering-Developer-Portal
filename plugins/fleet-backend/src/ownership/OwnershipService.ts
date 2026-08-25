import type { LoggerService } from '@backstage/backend-plugin-api';
import type { OwnershipStore } from '../database/OwnershipStore';
import type { RepositoryStore } from '../database/RepositoryStore';
import type { SyncStateStore } from '../database/SyncStateStore';
import type { OwnershipResolver } from './types';

export interface OwnershipServiceOptions {
  resolver: OwnershipResolver;
  repositories: RepositoryStore;
  ownership: OwnershipStore;
  syncState: SyncStateStore;
  logger: LoggerService;
  windowDays?: number;
}

export interface OwnershipSummary {
  repositories: number;
  /** Repositories where a name was confident enough to put forward. */
  proposed: number;
  /** Repositories with commit history but no clear leader. */
  contested: number;
  /** Repositories with no commit history in the window. */
  silent: number;
  failures: number;
}

const DEFAULT_WINDOW_DAYS = 90;

/**
 * Refreshes the derived ownership candidates for every live repository.
 *
 * Its own scheduled task rather than part of the scoring pass: it costs no
 * Bitbucket requests at all, reading only commits already stored, so it has no
 * reason to share scoring's schedule or its failure state. Keeping them
 * separate also means a broken resolver cannot stop scores being written.
 */
export class OwnershipService {
  private readonly resolver: OwnershipResolver;
  private readonly repositories: RepositoryStore;
  private readonly ownership: OwnershipStore;
  private readonly syncState: SyncStateStore;
  private readonly logger: LoggerService;
  private readonly windowDays: number;

  constructor(options: OwnershipServiceOptions) {
    this.resolver = options.resolver;
    this.repositories = options.repositories;
    this.ownership = options.ownership;
    this.syncState = options.syncState;
    this.logger = options.logger;
    this.windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS;
  }

  static resourceKey(workspace: string): string {
    return `ownership:${workspace}`;
  }

  async resolveAll(
    workspace: string,
    now: Date = new Date(),
  ): Promise<OwnershipSummary> {
    const resource = OwnershipService.resourceKey(workspace);
    await this.syncState.recordAttempt(resource, now);

    const since = new Date(
      now.getTime() - this.windowDays * 24 * 60 * 60 * 1000,
    );
    let proposed = 0;
    let contested = 0;
    let silent = 0;
    let failures = 0;

    try {
      const live = await this.repositories.listLive(workspace);

      for (const repository of live) {
        try {
          const proposal = await this.resolver.resolve(repository.id, since);
          await this.ownership.replaceForRepository(
            repository.id,
            proposal,
            this.resolver.source,
            now,
          );

          if (proposal.candidates.length === 0) silent++;
          else if (proposal.proposed) proposed++;
          else contested++;
        } catch (error) {
          failures++;
          this.logger.warn(
            `Ownership resolution failed for '${workspace}/${
              repository.slug
            }': ${(error as Error).message}`,
          );
        }
      }

      const summary: OwnershipSummary = {
        repositories: live.length,
        proposed,
        contested,
        silent,
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
        `Ownership for '${workspace}' via ${this.resolver.source}: ` +
          `${summary.proposed} proposed, ${summary.contested} with no clear ` +
          `owner, ${summary.silent} with no commits in ${this.windowDays} ` +
          `days, across ${summary.repositories} repositories ` +
          `(${summary.failures} failed)`,
      );
      return summary;
    } catch (error) {
      await this.syncState.recordFailure(resource, error as Error, now);
      throw error;
    }
  }
}
