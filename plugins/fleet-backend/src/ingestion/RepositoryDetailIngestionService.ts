import type { LoggerService } from '@backstage/backend-plugin-api';
import { analyseTechStack, manifestsWorthReading } from '../analysis/techStack';
import type { BitbucketClient } from '../bitbucket/types';
import type { BranchStore } from '../database/BranchStore';
import type { PipelineStore } from '../database/PipelineStore';
import type { RepositoryStore } from '../database/RepositoryStore';
import type { SyncStateStore } from '../database/SyncStateStore';

export interface RepositoryDetailIngestionServiceOptions {
  client: BitbucketClient;
  repositories: RepositoryStore;
  branches: BranchStore;
  pipelines: PipelineStore;
  syncState: SyncStateStore;
  logger: LoggerService;
  /** Recent runs kept per repository. Defaults to 20. */
  pipelineRunLimit?: number;
}

export interface RepositoryDetailSummary {
  repositories: number;
  branches: number;
  pipelineRuns: number;
  rootListings: number;
  stacksDerived: number;
  failures: number;
  requests: number;
}

const DEFAULT_PIPELINE_RUN_LIMIT = 20;

/**
 * Refreshes the per-repository snapshots: branches and recent pipeline runs.
 *
 * Both in one pass because they share the repository loop and neither is
 * historical -- unlike commits, these are re-read wholesale each time, so
 * there is nothing to resume from and no benefit to separate schedules.
 */
export class RepositoryDetailIngestionService {
  private readonly client: BitbucketClient;
  private readonly repositories: RepositoryStore;
  private readonly branches: BranchStore;
  private readonly pipelines: PipelineStore;
  private readonly syncState: SyncStateStore;
  private readonly logger: LoggerService;
  private readonly pipelineRunLimit: number;

  constructor(options: RepositoryDetailIngestionServiceOptions) {
    this.client = options.client;
    this.repositories = options.repositories;
    this.branches = options.branches;
    this.pipelines = options.pipelines;
    this.syncState = options.syncState;
    this.logger = options.logger;
    this.pipelineRunLimit =
      options.pipelineRunLimit ?? DEFAULT_PIPELINE_RUN_LIMIT;
  }

  static resourceKey(workspace: string): string {
    return `repository-detail:${workspace}`;
  }

  async ingest(
    workspace: string,
    now: Date = new Date(),
  ): Promise<RepositoryDetailSummary> {
    const resource = RepositoryDetailIngestionService.resourceKey(workspace);
    await this.syncState.recordAttempt(resource, now);

    const startedRequests = this.client.requestCount;
    let branchCount = 0;
    let runCount = 0;
    let listingCount = 0;
    let stackCount = 0;
    let failures = 0;

    try {
      const live = await this.repositories.listLive(workspace);

      for (const repository of live) {
        try {
          const fetched = await this.client.listBranches(
            workspace,
            repository.slug,
          );
          branchCount += await this.branches.replaceForRepository(
            repository.id,
            fetched,
            repository.default_branch,
          );

          const runs = await this.client.listPipelineRuns(
            workspace,
            repository.slug,
            { limit: this.pipelineRunLimit },
          );
          runCount += await this.pipelines.replaceForRepository(
            repository.id,
            runs,
          );

          const rootFiles = await this.client.listRootFiles(
            workspace,
            repository.slug,
            repository.default_branch ?? undefined,
          );
          await this.repositories.setRootFiles(repository.id, rootFiles);
          listingCount++;

          // Ecosystem comes free from the listing already in hand. Framework
          // detail costs one request per manifest, so only manifests whose
          // contents actually add something are fetched.
          const manifests: Record<string, string> = {};
          for (const path of manifestsWorthReading(rootFiles)) {
            const contents = await this.client.getFileContent(
              workspace,
              repository.slug,
              path,
              repository.default_branch ?? undefined,
            );
            if (contents) manifests[path] = contents;
          }

          const analysis = analyseTechStack(rootFiles, manifests);
          await this.repositories.setTechStack(
            repository.id,
            analysis.stack,
            analysis.language,
          );
          if (analysis.stack.length > 0) stackCount++;
        } catch (error) {
          // One unreachable repository must not abandon the rest.
          failures++;
          this.logger.warn(
            `Detail ingestion failed for '${workspace}/${repository.slug}': ${
              (error as Error).message
            }`,
          );
        }
      }

      const summary: RepositoryDetailSummary = {
        repositories: live.length,
        branches: branchCount,
        pipelineRuns: runCount,
        rootListings: listingCount,
        stacksDerived: stackCount,
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
        `Detail sync for '${workspace}': ${summary.branches} branches, ` +
          `${summary.pipelineRuns} pipeline runs, ${summary.stacksDerived} tech ` +
          `stacks across ${summary.repositories} repositories ` +
          `(${summary.failures} failed) using ${summary.requests} request(s)`,
      );
      return summary;
    } catch (error) {
      await this.syncState.recordFailure(resource, error as Error, now);
      throw error;
    }
  }
}
