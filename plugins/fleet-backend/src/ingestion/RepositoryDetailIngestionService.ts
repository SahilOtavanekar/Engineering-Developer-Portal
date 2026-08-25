import type { LoggerService } from '@backstage/backend-plugin-api';
import { classifyRepository } from '../analysis/classification';
import { analyseTechStack, manifestsWorthReading } from '../analysis/techStack';
import type { BitbucketClient } from '../bitbucket/types';
import type { BranchStore } from '../database/BranchStore';
import type { DeploymentStore } from '../database/DeploymentStore';
import type { PipelineStore } from '../database/PipelineStore';
import type { RepositoryStore } from '../database/RepositoryStore';
import type { SyncStateStore } from '../database/SyncStateStore';

export interface RepositoryDetailIngestionServiceOptions {
  client: BitbucketClient;
  repositories: RepositoryStore;
  branches: BranchStore;
  pipelines: PipelineStore;
  deployments: DeploymentStore;
  syncState: SyncStateStore;
  logger: LoggerService;
  /** Recent runs kept per repository. Defaults to 20. */
  pipelineRunLimit?: number;
  /** Recent deployments kept per repository. Defaults to 50. */
  deploymentLimit?: number;
}

export interface RepositoryDetailSummary {
  repositories: number;
  branches: number;
  pipelineRuns: number;
  deployments: number;
  rootListings: number;
  stacksDerived: number;
  /** Repositories the classifier could name a type or lifecycle for. */
  classified: number;
  failures: number;
  requests: number;
}

const DEFAULT_PIPELINE_RUN_LIMIT = 20;
const DEFAULT_DEPLOYMENT_LIMIT = 50;

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
  private readonly deployments: DeploymentStore;
  private readonly syncState: SyncStateStore;
  private readonly logger: LoggerService;
  private readonly pipelineRunLimit: number;
  private readonly deploymentLimit: number;

  constructor(options: RepositoryDetailIngestionServiceOptions) {
    this.client = options.client;
    this.repositories = options.repositories;
    this.branches = options.branches;
    this.pipelines = options.pipelines;
    this.deployments = options.deployments;
    this.syncState = options.syncState;
    this.logger = options.logger;
    this.pipelineRunLimit =
      options.pipelineRunLimit ?? DEFAULT_PIPELINE_RUN_LIMIT;
    this.deploymentLimit = options.deploymentLimit ?? DEFAULT_DEPLOYMENT_LIMIT;
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
    let deploymentCount = 0;
    let listingCount = 0;
    let stackCount = 0;
    let classifiedCount = 0;
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

          let environmentTypes: string[] = [];
          const runs = await this.client.listPipelineRuns(
            workspace,
            repository.slug,
            { limit: this.pipelineRunLimit },
          );
          runCount += await this.pipelines.replaceForRepository(
            repository.id,
            runs,
          );

          // Bitbucket only records a deployment when a pipeline declares one,
          // so a repository with no pipeline runs cannot have any. Skipping
          // the call saves a request each across the estate -- but the stored
          // snapshot still has to be cleared, or a repository whose pipelines
          // were removed would show a deployment that no longer exists.
          if (runs.length > 0) {
            const deployments = await this.client.listDeployments(
              workspace,
              repository.slug,
              { limit: this.deploymentLimit },
            );
            deploymentCount += await this.deployments.replaceForRepository(
              repository.id,
              deployments,
            );
            environmentTypes = [
              ...new Set(
                deployments
                  .filter(entry => entry.state === 'COMPLETED')
                  .map(entry => entry.environmentType)
                  .filter((type): type is string => Boolean(type)),
              ),
            ];
          } else {
            await this.deployments.replaceForRepository(repository.id, []);
          }

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

          // Classified here rather than in the entity provider: the inputs are
          // the stack just derived, the runs just fetched and the deployments
          // just stored, and this is the only place that holds all three.
          const classification = classifyRepository({
            techStack: analysis.stack,
            hasPipelineRuns: runs.length > 0,
            environmentTypes,
          });
          await this.repositories.setClassification(
            repository.id,
            classification,
          );
          if (
            classification.type !== 'unknown' ||
            classification.lifecycle !== 'unknown'
          ) {
            classifiedCount++;
          }
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
        deployments: deploymentCount,
        rootListings: listingCount,
        stacksDerived: stackCount,
        classified: classifiedCount,
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
          `${summary.pipelineRuns} pipeline runs, ${summary.deployments} ` +
          `deployments, ${summary.stacksDerived} tech stacks, ` +
          `${summary.classified} classified, across ` +
          `${summary.repositories} repositories ` +
          `(${summary.failures} failed) using ${summary.requests} request(s)`,
      );
      return summary;
    } catch (error) {
      await this.syncState.recordFailure(resource, error as Error, now);
      throw error;
    }
  }
}
