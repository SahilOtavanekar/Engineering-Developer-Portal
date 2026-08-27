import {
  coreServices,
  createBackendModule,
  type LoggerService,
  type SchedulerService,
} from '@backstage/backend-plugin-api';
import { fleetDatabaseClient } from './database/fleetDatabase';
import type { Config } from '@backstage/config';
import {
  catalogProcessingExtensionPoint,
  type CatalogProcessingExtensionPoint,
} from '@backstage/plugin-catalog-node';
import { BitbucketRepositoryEntityProvider } from './catalog/BitbucketRepositoryEntityProvider';
import { CommitAuthorEntityProvider } from './catalog/CommitAuthorEntityProvider';
import { OwnershipStore } from './database/OwnershipStore';
import { RepositoryStore } from './database/RepositoryStore';
import { CommitStore } from './database/CommitStore';

/**
 * How often derived Users are refreshed, and how far ahead of the repository
 * provider they run.
 *
 * Users first, deliberately: a Component whose `spec.owner` points at a User
 * that does not exist yet renders as a broken link. Both providers converge
 * within one cycle either way, but the first boot looks correct rather than
 * briefly broken.
 */
const USER_SCHEDULE = {
  frequency: { minutes: 30 },
  timeout: { minutes: 5 },
  initialDelay: { seconds: 10 },
};

/**
 * Registers the Bitbucket repository and commit-author entity providers.
 *
 * A catalog module rather than part of the fleet plugin itself, because entity
 * providers are consumed by the catalog's processing extension point.
 *
 * @public
 */
export const catalogModuleBitbucketRepositories = createBackendModule({
  pluginId: 'catalog',
  moduleId: 'fleet-bitbucket-repositories',
  register(env) {
    env.registerInit({
      deps: {
        catalog: catalogProcessingExtensionPoint,
        config: coreServices.rootConfig,
        logger: coreServices.logger,
        scheduler: coreServices.scheduler,
        lifecycle: coreServices.rootLifecycle,
      },
      async init({ catalog, config, logger, scheduler, lifecycle }) {
        const client = await fleetDatabaseClient(config, { logger, lifecycle });
        const ownership = new OwnershipStore(client);
        const repositories = new RepositoryStore(client);
        const commits = new CommitStore(client);

        addCommitAuthorProviders({
          catalog,
          config,
          logger,
          scheduler,
          ownership,
        });

        const providers = BitbucketRepositoryEntityProvider.fromConfig(config, {
          logger,
          scheduler,
          owners: ownership,
          classifications: repositories,
          branchPolicy: commits,
          branchPolicyWindowDays: config.getOptionalNumber(
            'fleet.scoring.disciplineWindowDays',
          ),
        });
        for (const provider of providers) {
          catalog.addEntityProvider(provider);
        }
      },
    });
  },
});

function addCommitAuthorProviders(options: {
  catalog: CatalogProcessingExtensionPoint;
  config: Config;
  logger: LoggerService;
  scheduler: SchedulerService;
  ownership: OwnershipStore;
}): void {
  const workspaces =
    options.config
      .getOptionalConfig('fleet.bitbucket')
      ?.getOptionalStringArray('workspaces') ?? [];

  for (const workspace of workspaces) {
    options.catalog.addEntityProvider(
      new CommitAuthorEntityProvider({
        workspace,
        ownership: options.ownership,
        logger: options.logger,
        taskRunner: options.scheduler.createScheduledTaskRunner(USER_SCHEDULE),
      }),
    );
  }
}
