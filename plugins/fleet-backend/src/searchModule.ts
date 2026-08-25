import {
  coreServices,
  createBackendModule,
} from '@backstage/backend-plugin-api';
import { searchIndexRegistryExtensionPoint } from '@backstage/plugin-search-backend-node/alpha';
import { fleetDatabaseClient } from './database/fleetDatabase';
import { DeploymentStore } from './database/DeploymentStore';
import { OwnershipStore } from './database/OwnershipStore';
import { RepositoryStore } from './database/RepositoryStore';
import { ScoreStore } from './database/ScoreStore';
import { FleetRepositoryCollatorFactory } from './search/FleetRepositoryCollatorFactory';

/**
 * Indexes fleet facts alongside the catalog.
 *
 * Ten minutes rather than the catalog collator's default: scores move on a
 * 30-minute cycle and deployments on a 30-minute detail pass, so anything
 * slower would routinely serve a band that had already changed.
 */
const SCHEDULE = {
  frequency: { minutes: 10 },
  timeout: { minutes: 5 },
  initialDelay: { seconds: 60 },
};

/**
 * Registers the fleet collator with the search index.
 *
 * A `search` module rather than part of the fleet plugin, because collators are
 * consumed by the search backend's index registry extension point.
 *
 * @public
 */
export const searchModuleFleetRepositories = createBackendModule({
  pluginId: 'search',
  moduleId: 'fleet-repositories',
  register(env) {
    env.registerInit({
      deps: {
        indexRegistry: searchIndexRegistryExtensionPoint,
        config: coreServices.rootConfig,
        logger: coreServices.logger,
        scheduler: coreServices.scheduler,
        lifecycle: coreServices.rootLifecycle,
      },
      async init({ indexRegistry, config, logger, scheduler, lifecycle }) {
        const client = await fleetDatabaseClient(config, { logger, lifecycle });

        indexRegistry.addCollator({
          schedule: scheduler.createScheduledTaskRunner(SCHEDULE),
          factory: new FleetRepositoryCollatorFactory({
            repositories: new RepositoryStore(client),
            scores: new ScoreStore(client),
            ownership: new OwnershipStore(client),
            deployments: new DeploymentStore(client),
            logger,
          }),
        });
      },
    });
  },
});
