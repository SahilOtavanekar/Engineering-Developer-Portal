import {
  coreServices,
  createBackendPlugin,
  readSchedulerServiceTaskScheduleDefinitionFromConfig,
  resolvePackagePath,
  type SchedulerServiceTaskScheduleDefinition,
} from '@backstage/backend-plugin-api';
import { ScmIntegrations } from '@backstage/integration';
import { BitbucketCloudClient } from './bitbucket/BitbucketCloudClient';
import { BranchStore } from './database/BranchStore';
import { CommitStore } from './database/CommitStore';
import { DeploymentStore } from './database/DeploymentStore';
import { OwnershipStore } from './database/OwnershipStore';
import { PipelineStore } from './database/PipelineStore';
import { PullRequestStore } from './database/PullRequestStore';
import { RepositoryStore } from './database/RepositoryStore';
import { ScoreStore } from './database/ScoreStore';
import { SyncStateStore } from './database/SyncStateStore';
import { CommitIngestionService } from './ingestion/CommitIngestionService';
import { PullRequestIngestionService } from './ingestion/PullRequestIngestionService';
import { RepositoryDetailIngestionService } from './ingestion/RepositoryDetailIngestionService';
import { CommitHistoryOwnershipResolver } from './ownership/CommitHistoryOwnershipResolver';
import { CompositeOwnershipResolver } from './ownership/CompositeOwnershipResolver';
import { PermissionOwnershipResolver } from './ownership/PermissionOwnershipResolver';
import { OwnershipService } from './ownership/OwnershipService';
import { createRouter } from './router';
import { describeBackoff, shouldSkip } from './sync/backoff';
import { PROVISIONAL_BANDS, ScoringEngine } from './scoring/ScoringEngine';
import { ScoringService } from './scoring/ScoringService';
import { activeCommitsScorer } from './scoring/scorers/activeCommits';
import { activeContributorsScorer } from './scoring/scorers/activeContributors';
import { branchHygieneScorer } from './scoring/scorers/branchHygiene';
import { codeReviewCompletedScorer } from './scoring/scorers/codeReviewCompleted';
import { pipelineHealthScorer } from './scoring/scorers/pipelineHealth';
import { readmeAvailableScorer } from './scoring/scorers/readmeAvailable';
import { unmeasuredScorer } from './scoring/scorers/unmeasured';
import { RepositoryIngestionService } from './ingestion/RepositoryIngestionService';

const migrationsDirectory = resolvePackagePath(
  '@internal/backstage-plugin-fleet-backend',
  'migrations',
);

const DEFAULT_SCHEDULE: SchedulerServiceTaskScheduleDefinition = {
  frequency: { minutes: 30 },
  timeout: { minutes: 10 },
  initialDelay: { seconds: 20 },
};

/**
 * Fleet backend plugin.
 *
 * Owns the repository fact store: raw data ingested from Bitbucket, the
 * rollups derived from it, and the health scores computed on a schedule.
 * Deliberately separate from the catalog, which holds identity, ownership and
 * relationships but has no history and is re-stitched on every refresh.
 *
 * @public
 */
export const fleetPlugin = createBackendPlugin({
  pluginId: 'fleet',
  register(env) {
    env.registerInit({
      deps: {
        config: coreServices.rootConfig,
        database: coreServices.database,
        httpAuth: coreServices.httpAuth,
        httpRouter: coreServices.httpRouter,
        logger: coreServices.logger,
        permissions: coreServices.permissions,
        scheduler: coreServices.scheduler,
      },
      async init({
        config,
        database,
        httpAuth,
        httpRouter,
        logger,
        permissions,
        scheduler,
      }) {
        const client = await database.getClient();
        await client.migrate.latest({ directory: migrationsDirectory });
        logger.info('Fleet database migrations applied');

        const repositoryStore = new RepositoryStore(client);
        const commitStore = new CommitStore(client);
        const branchStore = new BranchStore(client);
        const pipelineStore = new PipelineStore(client);
        const deploymentStore = new DeploymentStore(client);
        const ownershipStore = new OwnershipStore(client);
        const pullRequestStore = new PullRequestStore(client);
        const scoreStore = new ScoreStore(client);

        const scoringConfig = config.getOptionalConfig('fleet.scoring');
        const scoringWindowDays =
          scoringConfig?.getOptionalNumber('windowDays') ?? 90;
        const metrics = scoringConfig?.getOptionalConfig('metrics');

        // Weights and targets are config so they can be tuned without a
        // deploy. Defaults follow the weights in section 7 of the spec.
        const engine = new ScoringEngine({
          bands: {
            healthy:
              scoringConfig?.getOptionalNumber('bands.healthy') ??
              PROVISIONAL_BANDS.healthy,
            needsAttention:
              scoringConfig?.getOptionalNumber('bands.needsAttention') ??
              PROVISIONAL_BANDS.needsAttention,
          },
          scorers: [
            {
              scorer: activeCommitsScorer({
                target: metrics?.getOptionalNumber('activeCommits.target'),
              }),
              weight: metrics?.getOptionalNumber('activeCommits.weight') ?? 20,
            },
            {
              scorer: activeContributorsScorer({
                target: metrics?.getOptionalNumber('activeContributors.target'),
              }),
              weight:
                metrics?.getOptionalNumber('activeContributors.weight') ?? 10,
            },
            {
              scorer: pipelineHealthScorer(),
              weight:
                metrics?.getOptionalNumber('pipelinePassing.weight') ?? 20,
            },
            {
              scorer: branchHygieneScorer(),
              weight: metrics?.getOptionalNumber('branchHygiene.weight') ?? 10,
            },
            {
              scorer: codeReviewCompletedScorer(),
              weight:
                metrics?.getOptionalNumber('codeReviewCompleted.weight') ?? 15,
            },
            {
              scorer: readmeAvailableScorer(),
              weight:
                metrics?.getOptionalNumber('readmeAvailable.weight') ?? 10,
            },
            // Registered without a data source so their forfeited weight stays
            // visible rather than silently vanishing from the denominator.
            {
              scorer: unmeasuredScorer('owner-assigned', 'Owner assigned'),
              weight: metrics?.getOptionalNumber('ownerAssigned.weight') ?? 10,
            },
            {
              scorer: unmeasuredScorer(
                'security-scan-passing',
                'Security scan passing',
              ),
              weight:
                metrics?.getOptionalNumber('securityScanPassing.weight') ?? 5,
            },
          ],
        });

        httpRouter.use(
          await createRouter({
            repositories: repositoryStore,
            commits: commitStore,
            branches: branchStore,
            pullRequests: pullRequestStore,
            deployments: deploymentStore,
            pipelines: pipelineStore,
            ownership: ownershipStore,
            scores: scoreStore,
            nominalWeight: engine.nominalWeight,
            httpAuth,
            permissions,
            logger,
          }),
        );

        const fleetConfig = config.getOptionalConfig('fleet.bitbucket');
        const workspaces =
          fleetConfig?.getOptionalStringArray('workspaces') ?? [];

        if (workspaces.length === 0) {
          logger.warn(
            'No fleet.bitbucket.workspaces configured; repository facts will not be ingested',
          );
          return;
        }

        const integration =
          ScmIntegrations.fromConfig(config).bitbucketCloud.byHost(
            'bitbucket.org',
          );
        if (!integration) {
          throw new Error(
            'fleet.bitbucket.workspaces is configured but there is no integrations.bitbucketCloud entry for bitbucket.org',
          );
        }

        const repositories = repositoryStore;
        const commits = commitStore;
        const syncState = new SyncStateStore(client);
        const windowDays = fleetConfig?.getOptionalNumber('commitWindowDays');
        const schedule = fleetConfig?.has('schedule')
          ? readSchedulerServiceTaskScheduleDefinitionFromConfig(
              fleetConfig.getConfig('schedule'),
            )
          : DEFAULT_SCHEDULE;

        const newClient = () =>
          BitbucketCloudClient.fromIntegration(integration.config, { logger });

        for (const workspace of workspaces) {
          const repositoryIngestion = new RepositoryIngestionService({
            client: newClient(),
            repositories,
            syncState,
            logger,
          });

          const commitIngestion = new CommitIngestionService({
            client: newClient(),
            repositories,
            commits,
            syncState,
            logger,
            windowDays,
          });

          // Rethrowing from a scheduled task retires it permanently. Failures
          // are already recorded in sync_state, so we log and wait for the
          // next tick instead.
          const guard =
            (label: string, resource: string, run: () => Promise<unknown>) =>
            async () => {
              // Backoff lives here rather than in each service so every
              // scheduled task gets it: a resource that keeps failing should
              // stop spending quota on something that is not going to work.
              const state = await syncState.get(resource);
              if (shouldSkip(state, new Date())) {
                logger.info(
                  `${label} skipped for '${workspace}': ${describeBackoff(
                    state!,
                  )}`,
                );
                return;
              }

              try {
                await run();
              } catch (error) {
                logger.error(
                  `${label} failed for workspace '${workspace}'`,
                  error as Error,
                );
              }
            };

          await scheduler.scheduleTask({
            id: RepositoryIngestionService.resourceKey(workspace),
            ...schedule,
            fn: guard(
              'Repository ingestion',
              RepositoryIngestionService.resourceKey(workspace),
              () => repositoryIngestion.ingest(workspace),
            ),
          });

          await scheduler.scheduleTask({
            id: CommitIngestionService.resourceKey(workspace),
            ...schedule,
            // Offset so commit ingestion reads a repository list that the
            // repository sync has already refreshed.
            initialDelay: { seconds: 90 },
            fn: guard(
              'Commit ingestion',
              CommitIngestionService.resourceKey(workspace),
              () => commitIngestion.ingest(workspace),
            ),
          });

          const detailIngestion = new RepositoryDetailIngestionService({
            client: newClient(),
            repositories,
            branches: branchStore,
            pipelines: pipelineStore,
            deployments: deploymentStore,
            syncState,
            logger,
          });

          await scheduler.scheduleTask({
            id: RepositoryDetailIngestionService.resourceKey(workspace),
            ...schedule,
            initialDelay: { seconds: 120 },
            fn: guard(
              'Detail ingestion',
              RepositoryDetailIngestionService.resourceKey(workspace),
              () => detailIngestion.ingest(workspace),
            ),
          });

          const pullRequestIngestion = new PullRequestIngestionService({
            client: newClient(),
            repositories,
            pullRequests: pullRequestStore,
            syncState,
            logger,
            windowDays,
          });

          await scheduler.scheduleTask({
            id: PullRequestIngestionService.resourceKey(workspace),
            ...schedule,
            initialDelay: { seconds: 135 },
            fn: guard(
              'Pull request ingestion',
              PullRequestIngestionService.resourceKey(workspace),
              () => pullRequestIngestion.ingest(workspace),
            ),
          });

          // Reads only commits already stored, so it costs no Bitbucket
          // requests and can run alongside the ingestion passes rather than
          // after them.
          const ownershipConfig = config.getOptionalConfig('fleet.ownership');
          // Admin permission first, commit history second. Bitbucket's own
          // answer to "who is accountable" beats an inference from who types
          // most, and the two disagree far more often than not.
          const ownership = new OwnershipService({
            resolver: new CompositeOwnershipResolver({
              logger,
              resolvers: [
                new PermissionOwnershipResolver({
                  client: newClient(),
                  commits,
                  repositories,
                }),
                new CommitHistoryOwnershipResolver({
                  commits,
                  candidateLimit:
                    ownershipConfig?.getOptionalNumber('candidates') ??
                    undefined,
                  minimumShare:
                    ownershipConfig?.getOptionalNumber('minimumShare') ??
                    undefined,
                  minimumCommits:
                    ownershipConfig?.getOptionalNumber('minimumCommits') ??
                    undefined,
                }),
              ],
            }),
            repositories,
            ownership: ownershipStore,
            syncState,
            logger,
            windowDays: scoringWindowDays,
          });

          await scheduler.scheduleTask({
            id: OwnershipService.resourceKey(workspace),
            ...schedule,
            initialDelay: { seconds: 145 },
            fn: guard(
              'Ownership resolution',
              OwnershipService.resourceKey(workspace),
              () => ownership.resolveAll(workspace),
            ),
          });

          const scoring = new ScoringService({
            engine,
            repositories,
            commits,
            branches: branchStore,
            pipelines: pipelineStore,
            pullRequests: pullRequestStore,
            scores: scoreStore,
            syncState,
            logger,
            windowDays: scoringWindowDays,
          });

          await scheduler.scheduleTask({
            id: ScoringService.resourceKey(workspace),
            ...schedule,
            // Last in the chain: scores are only as good as the facts beneath
            // them, so this runs after both ingestion passes have had a turn.
            initialDelay: { seconds: 150 },
            fn: guard('Scoring', ScoringService.resourceKey(workspace), () =>
              scoring.scoreAll(workspace),
            ),
          });
        }
      },
    });
  },
});
