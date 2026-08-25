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
import { toUserEntityRef } from './userEntityName';
import type { BitbucketClient, BitbucketRepository } from '../bitbucket/types';
import type { StoredOwnershipCandidate } from '../database/OwnershipStore';

/** Namespace for annotations this provider owns. */
const ANNOTATION_NS = 'fleet.backstage.io';

export const ANNOTATION_WORKSPACE = `${ANNOTATION_NS}/bitbucket-workspace`;
export const ANNOTATION_SLUG = `${ANNOTATION_NS}/bitbucket-slug`;
export const ANNOTATION_PROJECT_KEY = `${ANNOTATION_NS}/bitbucket-project`;
export const ANNOTATION_DEFAULT_BRANCH = `${ANNOTATION_NS}/default-branch`;
export const ANNOTATION_OWNERSHIP_SOURCE = `${ANNOTATION_NS}/ownership-source`;
export const ANNOTATION_OWNERSHIP_EVIDENCE = `${ANNOTATION_NS}/ownership-evidence`;

/**
 * Marks an owner the portal inferred rather than one anybody confirmed.
 *
 * The catalog's Owner column cannot carry a caveat -- it renders a name and
 * nothing else -- so the caveat goes here, where it is filterable. "Show me
 * everything whose owner is still a guess" is one click, and the scorecard
 * reads this tag to refuse to award the ownership metric.
 */
export const TAG_UNCONFIRMED_OWNER = 'unconfirmed-owner';

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

/**
 * Supplies proposed owners keyed by repository slug.
 *
 * An interface rather than the store itself so the provider keeps working when
 * ownership is unavailable -- on a first boot the fleet migrations may not have
 * run yet, and a catalog that refuses to register 95 repositories because it
 * could not read a derived hint would be a poor trade.
 */
export interface ProposedOwnerSource {
  proposedForWorkspace(
    workspace: string,
  ): Promise<Map<string, StoredOwnershipCandidate>>;
}

/**
 * Supplies derived component type and lifecycle keyed by repository slug.
 *
 * A slug absent from the map means "not classified yet", which keeps the
 * placeholders. A slug present with `unknown` means the classifier looked and
 * found no evidence -- a different thing, and worth telling apart.
 */
export interface ClassificationSource {
  classificationForWorkspace(
    workspace: string,
  ): Promise<Map<string, { type: string; lifecycle: string }>>;
}

export interface BitbucketRepositoryEntityProviderOptions {
  workspace: string;
  client: BitbucketClient;
  taskRunner: SchedulerServiceTaskRunner;
  logger: LoggerService;
  /** Absent means every repository keeps the placeholder owner. */
  owners?: ProposedOwnerSource;
  /** Absent means every repository keeps `service` / `unknown`. */
  classifications?: ClassificationSource;
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
  private readonly owners?: ProposedOwnerSource;
  private readonly classifications?: ClassificationSource;
  private connection?: EntityProviderConnection;

  constructor(options: BitbucketRepositoryEntityProviderOptions) {
    this.workspace = options.workspace;
    this.client = options.client;
    this.taskRunner = options.taskRunner;
    this.logger = options.logger;
    this.owners = options.owners;
    this.classifications = options.classifications;
  }

  /**
   * Builds one provider per configured workspace.
   *
   * Workspaces must be configured explicitly -- Atlassian removed the
   * endpoints that enumerated them (CHANGE-2770), so they cannot be discovered.
   */
  static fromConfig(
    config: Config,
    options: {
      logger: LoggerService;
      scheduler: SchedulerService;
      owners?: ProposedOwnerSource;
      classifications?: ClassificationSource;
    },
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
          owners: options.owners,
          classifications: options.classifications,
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
    const [proposed, classified] = await Promise.all([
      this.readProposedOwners(),
      this.readClassifications(),
    ]);
    const entities = repositories.map(repository =>
      this.toEntity(
        repository,
        proposed.get(repository.slug),
        classified.get(repository.slug),
      ),
    );

    await this.connection.applyMutation({
      type: 'full',
      entities: entities.map(entity => ({
        entity,
        locationKey: this.getProviderName(),
      })),
    });

    const withOwner = entities.filter(entity =>
      entity.metadata.tags?.includes(TAG_UNCONFIRMED_OWNER),
    ).length;
    this.logger.info(
      `Registered ${entities.length} repositories from Bitbucket workspace ` +
        `'${this.workspace}' (${withOwner} with a proposed owner, ` +
        `${entities.length - withOwner} still unowned)`,
    );
  }

  /**
   * Proposed owners, or none if they cannot be read.
   *
   * Ownership is a derived hint. Losing it should degrade the catalog to
   * placeholder owners, not prevent the estate being registered at all.
   */
  private async readProposedOwners(): Promise<
    Map<string, StoredOwnershipCandidate>
  > {
    if (!this.owners) return new Map();
    try {
      return await this.owners.proposedForWorkspace(this.workspace);
    } catch (error) {
      this.logger.warn(
        `Could not read proposed owners for '${this.workspace}', ` +
          `falling back to ${DEFAULT_OWNER}: ${(error as Error).message}`,
      );
      return new Map();
    }
  }

  /**
   * Derived classifications, or none if they cannot be read.
   *
   * Same reasoning as ownership: a derived hint that fails to load should cost
   * the reader precision, not cost them the estate.
   */
  private async readClassifications(): Promise<
    Map<string, { type: string; lifecycle: string }>
  > {
    if (!this.classifications) return new Map();
    try {
      return await this.classifications.classificationForWorkspace(
        this.workspace,
      );
    } catch (error) {
      this.logger.warn(
        `Could not read classifications for '${this.workspace}', keeping ` +
          `placeholders: ${(error as Error).message}`,
      );
      return new Map();
    }
  }

  private toEntity(
    repository: BitbucketRepository,
    proposed?: StoredOwnershipCandidate,
    classification?: { type: string; lifecycle: string },
  ): ComponentEntity {
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

    // A proposal only becomes the owner if it can be addressed as an entity.
    // Without a resolvable ref the catalog renders a broken link, which reads
    // as a defect rather than as a gap.
    const proposedRef = proposed?.email
      ? toUserEntityRef(proposed.email)
      : undefined;
    const tags = [tag, proposedRef ? TAG_UNCONFIRMED_OWNER : undefined].filter(
      (value): value is string => Boolean(value),
    );

    if (proposedRef && proposed) {
      annotations[ANNOTATION_OWNERSHIP_SOURCE] = proposed.source;
      annotations[ANNOTATION_OWNERSHIP_EVIDENCE] =
        `${proposed.commits} of ${proposed.windowCommits} commits in ` +
        `${proposed.windowDays} days`;
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
        ...(tags.length > 0 ? { tags } : {}),
      },
      spec: {
        // Derived from the technology stack and from what actually deploys.
        // Falls back to the original placeholders when the classifier has not
        // reached this repository yet.
        type: classification?.type ?? 'service',
        lifecycle: classification?.lifecycle ?? 'unknown',
        owner: proposedRef ?? DEFAULT_OWNER,
      },
    };
  }
}
