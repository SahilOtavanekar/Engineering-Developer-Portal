import type {
  LoggerService,
  SchedulerServiceTaskRunner,
} from '@backstage/backend-plugin-api';
import {
  ANNOTATION_LOCATION,
  ANNOTATION_ORIGIN_LOCATION,
  type UserEntity,
} from '@backstage/catalog-model';
import type {
  EntityProvider,
  EntityProviderConnection,
} from '@backstage/plugin-catalog-node';
import type { OwnershipStore } from '../database/OwnershipStore';
import { toUserEntityName } from './userEntityName';

/** Namespace shared with the repository provider. */
const ANNOTATION_NS = 'fleet.backstage.io';

export const ANNOTATION_AUTHOR_EMAIL = `${ANNOTATION_NS}/author-email`;
export const ANNOTATION_IDENTITY_SOURCE = `${ANNOTATION_NS}/identity-source`;

/** Marks these Users as derived, not supplied by a directory. */
export const TAG_DERIVED_IDENTITY = 'derived-identity';

export interface CommitAuthorEntityProviderOptions {
  workspace: string;
  ownership: OwnershipStore;
  taskRunner: SchedulerServiceTaskRunner;
  logger: LoggerService;
}

/**
 * Registers a catalog User for each person the portal names.
 *
 * These exist so that ownership can point at somebody. A `spec.owner` of
 * `user:default/brijesh.gupta` renders as a dangling reference unless the User
 * entity is there, and a dangling owner is worse than a placeholder one --
 * it looks like a bug rather than a gap.
 *
 * Scoped to people who appear as an ownership candidate, not to every commit
 * author. The portal has something to say about the former; a User for someone
 * it never references is noise in a catalog whose whole value is that its
 * contents mean something.
 *
 * **Not an identity source of record.** Microsoft Entra is, and it is deferred
 * to the end of the build. Everything here is tagged `derived-identity` so the
 * two can be told apart, and so this provider's entities can be retired in one
 * query when the real directory arrives.
 */
export class CommitAuthorEntityProvider implements EntityProvider {
  private readonly workspace: string;
  private readonly ownership: OwnershipStore;
  private readonly taskRunner: SchedulerServiceTaskRunner;
  private readonly logger: LoggerService;
  private connection?: EntityProviderConnection;

  constructor(options: CommitAuthorEntityProviderOptions) {
    this.workspace = options.workspace;
    this.ownership = options.ownership;
    this.taskRunner = options.taskRunner;
    this.logger = options.logger;
  }

  getProviderName(): string {
    return `fleet-commit-authors:${this.workspace}`;
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
            `Commit author ingestion failed for workspace '${this.workspace}'`,
            error as Error,
          );
        }
      },
    });
  }

  async refresh(): Promise<void> {
    if (!this.connection) {
      throw new Error(`${this.getProviderName()} is not connected`);
    }

    const authors = await this.ownership.candidateAuthors(this.workspace);
    const entities: UserEntity[] = [];
    const seen = new Set<string>();
    let unusable = 0;

    for (const author of authors) {
      const name = toUserEntityName(author.email);
      if (!name) {
        unusable++;
        continue;
      }
      // Two addresses can reduce to one name -- `a.b@x` and `a.b@y`. First
      // wins, which is the busiest contributor, and the rest are dropped
      // rather than silently overwriting an entity mid-mutation.
      if (seen.has(name)) continue;
      seen.add(name);
      entities.push(this.toEntity(name, author));
    }

    await this.connection.applyMutation({
      type: 'full',
      entities: entities.map(entity => ({
        entity,
        locationKey: this.getProviderName(),
      })),
    });

    const skipped =
      unusable > 0 ? ` (${unusable} address(es) unusable as a name)` : '';
    this.logger.info(
      `Registered ${entities.length} commit authors as catalog Users for workspace '${this.workspace}'${skipped}`,
    );
  }

  private toEntity(
    name: string,
    author: { name?: string; email: string; accountId?: string },
  ): UserEntity {
    // A synthetic location: these people come from commit history, not from a
    // file anyone can open, and saying so is better than pointing at nothing.
    const location = `fleet-commit-authors:${this.workspace}`;

    return {
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'User',
      metadata: {
        name,
        ...(author.name ? { title: author.name } : {}),
        description:
          'Derived from Bitbucket commit history, not from a directory.',
        annotations: {
          [ANNOTATION_LOCATION]: location,
          [ANNOTATION_ORIGIN_LOCATION]: location,
          [ANNOTATION_AUTHOR_EMAIL]: author.email,
          [ANNOTATION_IDENTITY_SOURCE]: 'commit-history',
        },
        tags: [TAG_DERIVED_IDENTITY],
      },
      spec: {
        profile: {
          ...(author.name ? { displayName: author.name } : {}),
          email: author.email,
        },
        // No group membership is claimed. There is no team data in the estate,
        // and inventing one would put a fiction into the org chart.
        memberOf: [],
      },
    };
  }
}
