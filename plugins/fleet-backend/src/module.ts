import {
  coreServices,
  createBackendModule,
} from '@backstage/backend-plugin-api';
import { catalogProcessingExtensionPoint } from '@backstage/plugin-catalog-node';
import { BitbucketRepositoryEntityProvider } from './catalog/BitbucketRepositoryEntityProvider';

/**
 * Registers the Bitbucket repository entity providers with the catalog.
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
      },
      async init({ catalog, config, logger, scheduler }) {
        const providers = BitbucketRepositoryEntityProvider.fromConfig(config, {
          logger,
          scheduler,
        });
        for (const provider of providers) {
          catalog.addEntityProvider(provider);
        }
      },
    });
  },
});
