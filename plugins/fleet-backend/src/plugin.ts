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
import { RegisterOwnershipResolver } from './ownership/RegisterOwnershipResolver';
import { readOwnershipRegister } from './ownership/ownershipRegister';
import { OwnershipService } from './ownership/OwnershipService';
import { createRouter } from './router';
import { describeBackoff, shouldSkip } from './sync/backoff';
import { DEFAULT_BANDS, ScoringEngine } from './scoring/ScoringEngine';
import { ScoringService } from './scoring/ScoringService';
import { activeDevelopmentScorer } from './scoring/scorers/activeDevelopment';
import { pullRequestSizeScorer } from './scoring/scorers/pullRequestSize';
import { mainBranchCurrentScorer } from './scoring/scorers/mainBranchCurrent';
import {
  DEFAULT_STALE_BRANCH_EXEMPTIONS,
  staleBranchesScorer,
} from './scoring/scorers/staleBranches';
import { codeReviewCompletedScorer } from './scoring/scorers/codeReviewCompleted';
import { readmeAvailableScorer } from './scoring/scorers/readmeAvailable';
import { pullRequestDisciplineScorer } from './scoring/scorers/pullRequestDiscipline';
import { BranchPolicyService } from './analysis/BranchPolicyService';
import { BranchDivergenceService } from './analysis/BranchDivergenceService';
import { PullRequestSizeService } from './analysis/PullRequestSizeService';
import { ProductivityStore } from './database/ProductivityStore';
import { ProductivityService } from './productivity/ProductivityService';
import { readIdentityRegister } from './identity/identityRegister';
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

        // Branches that are stale by design. Read here rather than inside the
        // scorer because the exemption has to reach the **store**: the scorer
        // only ever sees counts, and the repository card names the stalest
        // branches from a separate query. Both must apply the same list or the
        // card accuses a team of neglect the score has already forgiven.
        const staleBranchExemptions =
          metrics?.getOptionalStringArray('staleBranches.exempt') ??
          DEFAULT_STALE_BRANCH_EXEMPTIONS;

        // Weights and targets are config so they can be tuned without a
        // deploy. Defaults follow the weights in section 7 of the spec.
        const engine = new ScoringEngine({
          bands: {
            excellent:
              scoringConfig?.getOptionalNumber('bands.excellent') ??
              DEFAULT_BANDS.excellent,
            healthy:
              scoringConfig?.getOptionalNumber('bands.healthy') ??
              DEFAULT_BANDS.healthy,
            needsAttention:
              scoringConfig?.getOptionalNumber('bands.needsAttention') ??
              DEFAULT_BANDS.needsAttention,
          },
          // **Exactly the seven rules the requirement specifies, in the order
          // it lists them and at the weights it gives them.** The card renders
          // the breakdown in registration order, so a reader can hold the
          // document beside the page and check it line by line.
          //
          // Three metrics were dropped here at the product owner's direction:
          // `activeContributors`, `pipelinePassing` and `ownerAssigned`. All
          // three worked and all three scored; none is in the rule set, and
          // the instruction was to show only what the requirement demands.
          // Losing pipeline passing costs the most -- it was the estate's most
          // widespread problem at 38 repositories -- and the ownership
          // register is untouched, so the catalog owner, the tags and the
          // About card all still work. Only the scoring stops.
          scorers: [
            {
              scorer: mainBranchCurrentScorer(),
              weight:
                metrics?.getOptionalNumber('mainBranchCurrent.weight') ?? 20,
            },
            {
              scorer: staleBranchesScorer(),
              weight: metrics?.getOptionalNumber('staleBranches.weight') ?? 15,
            },
            {
              // Its own shorter window, set on the service rather than here so
              // the scorer and the query that feeds it cannot disagree.
              scorer: pullRequestDisciplineScorer({
                windowDays:
                  scoringConfig?.getOptionalNumber('disciplineWindowDays') ??
                  undefined,
              }),
              weight:
                metrics?.getOptionalNumber('pullRequestDiscipline.weight') ??
                20,
            },
            {
              scorer: codeReviewCompletedScorer({
                countSelfApprovals: metrics?.getOptionalBoolean(
                  'codeReviewCompleted.countSelfApprovals',
                ),
              }),
              weight:
                metrics?.getOptionalNumber('codeReviewCompleted.weight') ?? 15,
            },
            {
              // Measurable now. It was an `unmeasuredScorer` forfeiting all 10
              // points until `PullRequestSizeService` landed the diffstat --
              // one request per merged pull request, which is why that has a
              // pass and a budget of its own rather than riding an existing
              // sweep. A repository whose pull requests have not been measured
              // yet still scores as unmeasurable rather than as small.
              scorer: pullRequestSizeScorer({
                statistic: metrics?.getOptionalString(
                  'pullRequestSize.statistic',
                ) as 'mean' | 'median' | undefined,
              }),
              weight:
                metrics?.getOptionalNumber('pullRequestSize.weight') ?? 10,
            },
            {
              scorer: activeDevelopmentScorer(),
              weight:
                metrics?.getOptionalNumber('activeDevelopment.weight') ?? 10,
            },
            {
              scorer: readmeAvailableScorer(),
              weight:
                metrics?.getOptionalNumber('readmeAvailable.weight') ?? 10,
            },
          ],
        });

        // Read once at startup. Reference data, not something that changes
        // under a running process; edit and restart.
        const identity = readIdentityRegister(
          config.getOptionalConfig('fleet.identity.register'),
          logger,
        );
        if (identity.people.length === 0) {
          logger.warn(
            'No fleet.identity.register configured; per-engineer productivity ' +
              'is unavailable, because a commit address is not a person and ' +
              'aggregating raw addresses would split people into several ' +
              'engineers each',
          );
        } else {
          logger.info(
            `Identity register: ${identity.people.length} people across ` +
              `${identity.byAddress.size} addresses, ` +
              `${identity.excluded.size} address(es) excluded as not people`,
          );
        }

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
            productivity:
              identity.people.length > 0
                ? new ProductivityService({
                    store: new ProductivityStore(client),
                    register: identity,
                    logger,
                  })
                : undefined,
            productivityWindowDays: scoringWindowDays,
            // Names the repository creator and the contributor list. Passed
            // even when empty: the router then reports raw addresses rather
            // than nothing, and the register is optional configuration.
            identity,
            disciplineWindowDays:
              scoringConfig?.getOptionalNumber('disciplineWindowDays') ??
              undefined,
            staleBranchExemptions,
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
          // The confirmed register first, then admin permission, then commit
          // history. The two inferences were measured against the register at
          // 76% and 78%, so neither is the authority it was taken for -- but
          // between them they still answer for the repositories nobody has
          // written down yet.
          const register = readOwnershipRegister(
            ownershipConfig?.getOptionalConfig('register'),
            logger,
          );
          if (register.repositories.size === 0) {
            logger.warn(
              'No fleet.ownership.register configured; every owner the portal ' +
                'shows will be an inference from admin permission or commit ' +
                'history, which measured 76% and 78% accurate against the ' +
                'repository standardization document',
            );
          } else {
            logger.info(
              `Ownership register: ${register.repositories.size} repositories ` +
                `confirmed across ${register.people.size} named people`,
            );
          }

          const ownership = new OwnershipService({
            resolver: new CompositeOwnershipResolver({
              logger,
              resolvers: [
                // First, and the only source that confirms rather than infers.
                new RegisterOwnershipResolver({
                  register,
                  repositories,
                  commits,
                }),
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
            ownership: ownershipStore,
            scores: scoreStore,
            syncState,
            logger,
            windowDays: scoringWindowDays,
            disciplineWindowDays:
              scoringConfig?.getOptionalNumber('disciplineWindowDays') ??
              undefined,
            // Must be the same list the router is given. Both are optional, so
            // omitting one here typechecks perfectly and simply scores the
            // exempt branches anyway -- the failure this threading exists to
            // prevent, arriving silently.
            staleBranchExemptions,
          });

          const branchPolicy = new BranchPolicyService({
            repositories,
            commits,
            pullRequests: pullRequestStore,
            syncState,
            logger,
          });

          await scheduler.scheduleTask({
            id: BranchPolicyService.resourceKey(workspace),
            ...schedule,
            // Ahead of scoring, and costing no Bitbucket requests: it reads
            // parent hashes and merge hashes that ingestion already stored.
            initialDelay: { seconds: 120 },
            fn: guard(
              'Branch policy',
              BranchPolicyService.resourceKey(workspace),
              () => branchPolicy.classifyAll(workspace),
            ),
          });

          const divergence = new BranchDivergenceService({
            repositories,
            branches: branchStore,
            syncState,
            client: newClient(),
            logger,
            requestBudget: fleetConfig?.getOptionalNumber(
              'branchDivergence.requestBudget',
            ),
          });

          await scheduler.scheduleTask({
            id: BranchDivergenceService.resourceKey(workspace),
            ...schedule,
            // Its own, much slower cadence. This is the only pass that costs a
            // request per *branch* rather than per repository -- about 185 for
            // this estate -- and divergence barely moves between one half-hour
            // and the next, so running it on the common schedule would spend
            // the whole request budget to learn nothing.
            frequency: {
              minutes:
                fleetConfig?.getOptionalNumber(
                  'branchDivergence.frequencyMinutes',
                ) ?? 360,
            },
            timeout: { minutes: 20 },
            initialDelay: { seconds: 180 },
            fn: guard(
              'Branch divergence',
              BranchDivergenceService.resourceKey(workspace),
              () => divergence.measureAll(workspace),
            ),
          });

          const pullRequestSize = new PullRequestSizeService({
            client: newClient(),
            pullRequests: pullRequestStore,
            syncState,
            logger,
            requestBudget: scoringConfig?.getOptionalNumber(
              'metrics.pullRequestSize.requestBudget',
            ),
            generatedPaths: scoringConfig?.getOptionalStringArray(
              'metrics.pullRequestSize.generatedPaths',
            ),
          });

          await scheduler.scheduleTask({
            id: PullRequestSizeService.resourceKey(workspace),
            ...schedule,
            // Its own slow cadence, like branch divergence and for the same
            // reason: this is the only pass costing a request per *pull
            // request* rather than per repository -- about 389 for the first
            // sweep of this estate. A merged pull request is immutable, so
            // afterwards it costs only what has merged since, which is a
            // handful. Running it every half hour would spend a budget to
            // learn nothing.
            frequency: {
              minutes:
                scoringConfig?.getOptionalNumber(
                  'metrics.pullRequestSize.frequencyMinutes',
                ) ?? 360,
            },
            // 40 minutes, not the 20 the other slow passes take. Measured on
            // the first live sweep: 390 sequential diffstat requests ran for
            // over 16 minutes, and a first sweep on a larger estate would meet
            // a 20-minute limit. Progress is written in batches, so a timeout
            // now costs at most one batch rather than the whole sweep.
            timeout: { minutes: 40 },
            // Behind pull request ingestion, which is what creates the rows
            // this pass then measures.
            initialDelay: { seconds: 210 },
            fn: guard(
              'Pull request size',
              PullRequestSizeService.resourceKey(workspace),
              () => pullRequestSize.measure(workspace),
            ),
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
