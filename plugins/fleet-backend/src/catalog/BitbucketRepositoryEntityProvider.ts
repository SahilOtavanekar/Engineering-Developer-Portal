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
  type SystemEntity,
} from '@backstage/catalog-model';
import { ScmIntegrations } from '@backstage/integration';
import type {
  EntityProvider,
  EntityProviderConnection,
} from '@backstage/plugin-catalog-node';
import { BitbucketCloudClient } from '../bitbucket/BitbucketCloudClient';
import { OWNERSHIP_SOURCE_REGISTER } from '../ownership/types';
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
 * No longer stamped on entities. Kept as the name of the *concept*, which the
 * provider's own log line still reports.
 *
 * It used to be applied to every confirmed repository so that a catalog filter
 * could express "show me everything with a real owner" -- a filter cannot ask
 * for the *absence* of a tag. Dropped 2026-09-02 at the product owner's
 * direction: it was on **89 of 95** repositories, so as a filter it selected
 * 94% of the estate, and as a chip it appeared on nearly every row of the
 * catalog table for no information.
 *
 * Nothing is lost that cannot be asked another way. The useful question is the
 * inverse -- {@link TAG_UNCONFIRMED_OWNER} still marks the 6 repositories whose
 * owner is a guess -- and the repository page states "Owner — confirmed" with
 * the register evidence beside it.
 *
 * **Hiding it in the table only was not possible.** The catalog's tag chips
 * render as `label={tag}` with no `title`, `aria-label` or `data-` attribute,
 * so no CSS selector can reach one by its text.
 */
export const TAG_CONFIRMED_OWNER = 'confirmed-owner';

/**
 * No longer stamped on entities.
 *
 * It marked a repository where work reached the default branch without a pull
 * request, so that "show me everything bypassing review" was a catalog filter
 * rather than a sort. Dropped 2026-09-02 at the product owner's direction.
 *
 * The information is not lost, and is now better placed than it was. Since the
 * tag was added, that behaviour became the **Main branch health** metric --
 * scored, with the three-way split of how work reached main in its detail --
 * and the Health Dashboard carries a "Changes bypassing pull requests" problem
 * chip that filters the same 7 repositories. A tag on 7 of 97 rows was the
 * weakest of the three surfaces.
 *
 * `branchPolicyForWorkspace` on `CommitStore` still exists and still feeds the
 * fleet overview, so restoring the tag is a two-line change if wanted.
 */
export const TAG_DIRECT_COMMITS = 'direct-commits-to-main';

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
  ): Promise<
    Map<string, { type: string; lifecycle: string; language?: string }>
  >;
}

/**
 * The grounds for a proposal, phrased to match where it came from.
 *
 * A commit share is the whole argument for a commit-history proposal and a
 * footnote for a permission-based one. Reporting "9 of 208 commits" as the
 * evidence for someone Bitbucket names as admin would read as an absurdly weak
 * justification for a claim that does not rest on commits at all.
 */
function describeEvidence(proposed: StoredOwnershipCandidate): string {
  const share =
    `${proposed.commits} of ${proposed.windowCommits} commits in ` +
    `${proposed.windowDays} days`;

  if (proposed.source === OWNERSHIP_SOURCE_REGISTER) {
    // Not evidence for an inference -- a person wrote this down. Saying
    // anything about commits first would invite the reader to re-derive a
    // conclusion that does not rest on them.
    return proposed.commits > 0
      ? `Confirmed in the ownership register, and ${share}`
      : 'Confirmed in the ownership register';
  }
  if (proposed.source === 'repository-admin') {
    return proposed.commits > 0
      ? `Repository admin in Bitbucket, and ${share}`
      : 'Repository admin in Bitbucket; no commits in the window';
  }
  return share;
}

/**
 * Which ownership caveat, if any, the entity should carry.
 *
 * The register is the only source that confirms rather than infers, so it is
 * the only one allowed to leave the caveat off. A named function rather than a
 * nested conditional because `no-nested-ternary` forbids the obvious form --
 * the same reason `PermissionOwnershipResolver.pick` exists.
 */
function ownerTag(
  proposedRef: string | undefined,
  proposed: StoredOwnershipCandidate | undefined,
): string | undefined {
  if (!proposedRef) return undefined;
  // Only the guess is tagged. A confirmed owner needs no chip on every row --
  // see TAG_CONFIRMED_OWNER for why that tag is no longer applied.
  return proposed?.source === OWNERSHIP_SOURCE_REGISTER
    ? undefined
    : TAG_UNCONFIRMED_OWNER;
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
/**
 * A Bitbucket project key as a Backstage entity name.
 *
 * Lowercased deliberately. `toEntityName` only strips characters Backstage
 * forbids, so `MDLH` would survive as `MDLH` -- and entity refs are lowercased
 * on several paths through the catalog and this plugin's own router, so a
 * mixed-case name invites a lookup that matches nothing. The original key is
 * kept as the System's title, which is what a reader sees.
 */
function toSystemName(projectKey: string): string {
  return toEntityName(projectKey.toLowerCase());
}

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
    // Emitted in the same mutation as the components that reference them: a
    // `spec.system` pointing at an entity the catalog does not hold renders as
    // a broken link, which reads as a defect rather than the gap it is.
    const systems = this.toSystemEntities(repositories);

    await this.connection.applyMutation({
      type: 'full',
      entities: [...systems, ...entities].map(entity => ({
        entity,
        locationKey: this.getProviderName(),
      })),
    });

    const counted = (want: string) =>
      entities.filter(entity => entity.metadata.tags?.includes(want)).length;
    const proposedOwners = counted(TAG_UNCONFIRMED_OWNER);
    // Counted from the owner ref rather than from a tag: `confirmed-owner` is
    // no longer stamped, so anything owned but not flagged as a guess is
    // confirmed.
    const owned = entities.filter(
      entity => entity.spec.owner !== DEFAULT_OWNER,
    ).length;
    const confirmedOwners = owned - proposedOwners;
    this.logger.info(
      `Registered ${entities.length} repositories from Bitbucket workspace ` +
        `'${this.workspace}' (${confirmedOwners} with a confirmed owner, ` +
        `${proposedOwners} with a proposed one, ` +
        `${entities.length - confirmedOwners - proposedOwners} still unowned)`,
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
    Map<string, { type: string; lifecycle: string; language?: string }>
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
    classification?: { type: string; lifecycle: string; language?: string },
  ): ComponentEntity {
    const location = `url:${repository.url}`;
    // Bitbucket's own detection first, then the language inferred from
    // manifests. Bitbucket reports one for only **6 of 96** repositories here,
    // so on its own it left the catalog's Tags column empty on 94% of rows;
    // the derived value covers 43. Source data still wins where it exists --
    // a guess must never overwrite a fact.
    const tag = toTag(repository.language ?? classification?.language ?? '');

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
    const tags = [tag, ownerTag(proposedRef, proposed)].filter(
      (value): value is string => Boolean(value),
    );

    if (proposedRef && proposed) {
      annotations[ANNOTATION_OWNERSHIP_SOURCE] = proposed.source;
      annotations[ANNOTATION_OWNERSHIP_EVIDENCE] = describeEvidence(proposed);
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
        // The Bitbucket project this repository belongs to. Every one of the
        // 96 has one, so the catalog's System column and filter -- blank on
        // every row until now -- become usable at no API cost.
        ...(repository.projectKey
          ? { system: toSystemName(repository.projectKey) }
          : {}),
      },
    };
  }

  /**
   * One System per Bitbucket project.
   *
   * A Bitbucket project is the closest thing this estate has to a Backstage
   * System: a named group of repositories that ship together. Six of them
   * cover all 96 repositories with no gaps.
   *
   * Owned by `unowned` rather than inferred. A project's components have
   * several different owners between them, and picking the commonest would
   * assert a responsibility nobody agreed to -- the same reason a derived
   * repository owner earns no points on the scorecard.
   */
  private toSystemEntities(
    repositories: BitbucketRepository[],
  ): SystemEntity[] {
    const keys = new Map<string, { key: string; label?: string }>();
    for (const repository of repositories) {
      if (!repository.projectKey) continue;
      keys.set(toSystemName(repository.projectKey), {
        key: repository.projectKey,
        label: repository.projectName,
      });
    }

    return [...keys.entries()].map(([name, project]) => ({
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'System',
      metadata: {
        name,
        // The full name is the title, so every surface rendering a System's
        // title shows it: the catalog's PROJECT column, the About card, the
        // relations graph and the project's own page heading.
        //
        // **Measured first, because fitting was the open question.** At the
        // catalog column's 198px, less 40px of cell padding and a 20px icon,
        // 138px is usable and the longest name -- "DAI Delivery Systems" --
        // renders at 130px. It fits at 1600px and at 1280px. Eight pixels of
        // headroom, so a project named longer than any in the workspace today
        // would truncate rather than wrap.
        //
        // Falls back to the key, which is also what the three projects whose
        // name IS their key get (DAARWYN, MDLH) or nearly (DAIWEB / DAI-WEB).
        title: project.label ?? project.key,
        // Plain context. The name is the title now, and leading the
        // description with it as well made a project's page read
        // "DAI Delivery Systems / DAI Delivery Systems. Bitbucket project ...".
        description: `Bitbucket project ${project.key} in workspace ${this.workspace}.`,
        annotations: {
          [ANNOTATION_LOCATION]: `${this.getProviderName()}:${name}`,
          [ANNOTATION_ORIGIN_LOCATION]: `${this.getProviderName()}:${name}`,
          [ANNOTATION_WORKSPACE]: this.workspace,
          [ANNOTATION_PROJECT_KEY]: project.key,
        },
      },
      spec: { owner: DEFAULT_OWNER },
    }));
  }
}
