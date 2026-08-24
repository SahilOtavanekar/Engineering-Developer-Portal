import type {
  LoggerService,
  SchedulerService,
  SchedulerServiceTaskRunner,
  SchedulerServiceTaskScheduleDefinition,
} from '@backstage/backend-plugin-api';
import { readSchedulerServiceTaskScheduleDefinitionFromConfig } from '@backstage/backend-plugin-api';
import type { Config } from '@backstage/config';
import {
  ANNOTATION_LOCATION,
  ANNOTATION_ORIGIN_LOCATION,
  ANNOTATION_SOURCE_LOCATION,
  type ComponentEntity,
} from '@backstage/catalog-model';
import { ScmIntegrations } from '@backstage/integration';
import type {
  EntityProvider,
  EntityProviderConnection,
} from '@backstage/plugin-catalog-node';
import { BitbucketCloudClient } from '../bitbucket/BitbucketCloudClient';
import { toEntityName } from './entityName';
import type { BitbucketClient, BitbucketRepository } from '../bitbucket/types';

/** Namespace for annotations this provider owns. */
const ANNOTATION_NS = 'fleet.backstage.io';

export const ANNOTATION_WORKSPACE = `${ANNOTATION_NS}/bitbucket-workspace`;
export const ANNOTATION_SLUG = `${ANNOTATION_NS}/bitbucket-slug`;
export const ANNOTATION_PROJECT_KEY = `${ANNOTATION_NS}/bitbucket-project`;
export const ANNOTATION_DEFAULT_BRANCH = `${ANNOTATION_NS}/default-branch`;

/**
 * Owner assigned to every repository until real ownership data exists.
 *
 * Deliberately a real group rather than an empty value: unowned repositories
 * must be visible and countable, because that count is the metric the
 * ownership campaign is measured against.
 */
const DEFAULT_OWNER = 'group:default/unowned';

const DEFAULT_SCHEDULE: SchedulerServiceTaskScheduleDefinition = {
  frequency: { minutes: 30 },
  timeout: { minutes: 10 },
  initialDelay: { seconds: 15 },
};

/** Catalog tags are lowercase alphanumerics separated by dashes. */
function toTag(value: string): string | undefined {
  const tag = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
  return tag || undefined;
}

export interface BitbucketRepositoryEntityProviderOptions {
  workspace: string;
  client: BitbucketClient;
  taskRunner: SchedulerServiceTaskRunner;
  logger: LoggerService;
}

/**
 * Registers every Bitbucket repository in a workspace as a catalog Component.
 *
 * This exists because the stock `BitbucketCloudEntityProvider` does not
 * enumerate repositories -- it searches for existing `catalog-info.yaml` files.
 * Zero repositories in this estate have one, so that provider would register
 * nothing. Descriptors, where they later appear, take precedence over what is
 * synthesized here.
 *
 * One provider instance per workspace: a `full` mutation replaces everything
 * the provider owns, so a failure in one workspace must not be able to empty
 * another.
 */
export class BitbucketRepositoryEntityProvider implements EntityProvider {
  private readonly workspace: string;
  private readonly client: BitbucketClient;
  private readonly taskRunner: SchedulerServiceTaskRunner;
  private readonly logger: LoggerService;
  private connection?: EntityProviderConnection;

  constructor(options: BitbucketRepositoryEntityProviderOptions) {
    this.workspace = options.workspace;
    this.client = options.client;
    this.taskRunner = options.taskRunner;
    this.logger = options.logger;
  }

  /**
   * Builds one provider per configured workspace.
   *
   * Workspaces must be configured explicitly -- Atlassian removed the
   * endpoints that enumerated them (CHANGE-2770), so they cannot be discovered.
   */
  static fromConfig(
    config: Config,
    options: { logger: LoggerService; scheduler: SchedulerService },
  ): BitbucketRepositoryEntityProvider[] {
    const root = config.getOptionalConfig('fleet.bitbucket');
    const workspaces = root?.getOptionalStringArray('workspaces') ?? [];

    if (workspaces.length === 0) {
      options.logger.warn(
        'No fleet.bitbucket.workspaces configured; no Bitbucket repositories will be ingested',
      );
      return [];
    }

    const integration =
      ScmIntegrations.fromConfig(config).bitbucketCloud.byHost('bitbucket.org');
    if (!integration) {
      throw new Error(
        'fleet.bitbucket.workspaces is configured but there is no integrations.bitbucketCloud entry for bitbucket.org',
      );
    }

    const schedule = root?.has('schedule')
      ? readSchedulerServiceTaskScheduleDefinitionFromConfig(
          root.getConfig('schedule'),
        )
      : DEFAULT_SCHEDULE;

    return workspaces.map(
      workspace =>
        new BitbucketRepositoryEntityProvider({
          workspace,
          logger: options.logger,
          client: BitbucketCloudClient.fromIntegration(integration.config, {
            logger: options.logger,
          }),
          taskRunner: options.scheduler.createScheduledTaskRunner(schedule),
        }),
    );
  }

  getProviderName(): string {
    return `bitbucket-repositories:${this.workspace}`;
  }

  async connect(connection: EntityProviderConnection): Promise<void> {
    this.connection = connection;
    await this.taskRunner.run({
      id: this.getProviderName(),
      fn: async () => {
        try {
          await this.refresh();
        } catch (error) {
          // Throwing here would kill the scheduled task for good; the catalog
          // keeps whatever was last applied and we try again next tick.
          this.logger.error(
            `Bitbucket repository ingestion failed for workspace '${this.workspace}'`,
            error as Error,
          );
        }
      },
    });
  }

  /** Fetches the workspace and replaces this provider's entities wholesale. */
  async refresh(): Promise<void> {
    if (!this.connection) {
      throw new Error(`${this.getProviderName()} is not connected`);
    }

    const repositories = await this.client.listRepositories(this.workspace);
    const entities = repositories.map(repository => this.toEntity(repository));

    await this.connection.applyMutation({
      type: 'full',
      entities: entities.map(entity => ({
        entity,
        locationKey: this.getProviderName(),
      })),
    });

    this.logger.info(
      `Registered ${entities.length} repositories from Bitbucket workspace '${this.workspace}'`,
    );
  }

  private toEntity(repository: BitbucketRepository): ComponentEntity {
    const location = `url:${repository.url}`;
    const tag = repository.language ? toTag(repository.language) : undefined;

    const annotations: Record<string, string> = {
      [ANNOTATION_LOCATION]: location,
      [ANNOTATION_ORIGIN_LOCATION]: location,
      [ANNOTATION_WORKSPACE]: repository.workspace,
      [ANNOTATION_SLUG]: repository.slug,
    };

    if (repository.defaultBranch) {
      annotations[ANNOTATION_DEFAULT_BRANCH] = repository.defaultBranch;
      annotations[
        ANNOTATION_SOURCE_LOCATION
      ] = `url:${repository.url}/src/${repository.defaultBranch}/`;
    }
    if (repository.projectKey) {
      annotations[ANNOTATION_PROJECT_KEY] = repository.projectKey;
    }

    return {
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'Component',
      metadata: {
        name: toEntityName(repository.slug),
        title: repository.name,
        ...(repository.description
          ? { description: repository.description }
          : {}),
        annotations,
        ...(tag ? { tags: [tag] } : {}),
      },
      spec: {
        // Bitbucket tells us nothing about either of these. Honest placeholders
        // beat invented precision; both get refined once manifests are parsed.
        type: 'service',
        lifecycle: 'unknown',
        owner: DEFAULT_OWNER,
      },
    };
  }
}
