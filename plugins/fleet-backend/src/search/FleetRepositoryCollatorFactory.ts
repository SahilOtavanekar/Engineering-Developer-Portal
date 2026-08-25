import { Readable } from 'stream';
import type { LoggerService } from '@backstage/backend-plugin-api';
import type {
  DocumentCollatorFactory,
  IndexableDocument,
} from '@backstage/plugin-search-common';
import { fleetRepositoryReadPermission } from '@internal/backstage-plugin-fleet-common';
import type { DeploymentStore } from '../database/DeploymentStore';
import type { OwnershipStore } from '../database/OwnershipStore';
import type { RepositoryStore } from '../database/RepositoryStore';
import type { ScoreStore } from '../database/ScoreStore';

/**
 * A repository as the search index holds it.
 *
 * The custom fields exist to be filtered and faceted on -- "critical Python
 * services that reach production" is a query over `band`, `technologies` and
 * `environments`, none of which the catalog knows anything about.
 */
export interface FleetRepositoryDocument extends IndexableDocument {
  slug: string;
  workspace: string;
  entityRef: string;
  /** Absent until a scoring run has covered the repository. */
  band?: string;
  score?: number;
  language?: string;
  technologies: string[];
  /** Bitbucket's environment types: Test, Staging, Production. */
  environments: string[];
  /** Display name of the proposed owner, when there is one. */
  owner?: string;
  /**
   * Always false today. Present so a search result can distinguish a confirmed
   * owner from a derived one the moment confirmed owners exist, without
   * reindexing being a breaking change.
   */
  ownerConfirmed: boolean;
  lastCommitAt?: string;
}

export interface FleetRepositoryCollatorFactoryOptions {
  repositories: RepositoryStore;
  scores: ScoreStore;
  ownership: OwnershipStore;
  deployments: DeploymentStore;
  logger: LoggerService;
}

/** Reads better in search results than the raw band value. */
const BAND_LABEL: Record<string, string> = {
  healthy: 'Healthy',
  'needs-attention': 'Needs attention',
  critical: 'Critical',
};

/**
 * Indexes the fleet database for search.
 *
 * The catalog collator already indexes identity -- name, description, tags.
 * None of what makes this portal useful is in the catalog: the score, the
 * technology stack, what is deployed where, who probably owns it. Without this,
 * "which critical Python services reach production" is a question you can only
 * answer by reading the fleet page and filtering by hand.
 *
 * Four batched queries regardless of estate size. A collator that issued one
 * query per repository would be invisible at 95 and ruinous at the 10,000 the
 * requirements imagine.
 */
export class FleetRepositoryCollatorFactory implements DocumentCollatorFactory {
  readonly type = 'fleet-repository';
  /**
   * Search honours the same permission as the fleet API, so indexing cannot
   * become a way to read facts a caller is not allowed to read.
   */
  readonly visibilityPermission = fleetRepositoryReadPermission;

  private readonly repositories: RepositoryStore;
  private readonly scores: ScoreStore;
  private readonly ownership: OwnershipStore;
  private readonly deployments: DeploymentStore;
  private readonly logger: LoggerService;

  constructor(options: FleetRepositoryCollatorFactoryOptions) {
    this.repositories = options.repositories;
    this.scores = options.scores;
    this.ownership = options.ownership;
    this.deployments = options.deployments;
    this.logger = options.logger;
  }

  async getCollator(): Promise<Readable> {
    return Readable.from(this.execute());
  }

  private async *execute(): AsyncGenerator<FleetRepositoryDocument> {
    const records = await this.repositories.listLive();
    const ids = records.map(record => record.id);

    const [latest, owners, environments] = await Promise.all([
      this.scores.latestForRepositories(ids),
      this.ownership.proposedForRepositories(ids),
      this.deployments.environmentTypesForRepositories(ids),
    ]);

    for (const record of records) {
      const score = latest.get(record.id);
      const owner = owners.get(record.id);
      const environmentTypes = environments.get(record.id) ?? [];
      const technologies = record.tech_stack ?? [];
      const language = record.language ?? record.derived_language ?? undefined;
      const ownerName = owner?.name ?? owner?.email ?? undefined;

      const bandLabel = score
        ? BAND_LABEL[score.band] ?? score.band
        : 'Not scored';

      yield {
        // The score rides in the title on purpose. The catalog collator already
        // indexes this repository under the same name and links to the same
        // page, so a bare slug here would give the reader two identical results
        // and no way to tell them apart. This one earns its place by answering
        // the question at a glance.
        title: score
          ? `${record.slug} · ${score.total} ${bandLabel}`
          : `${record.slug} · not scored`,
        // Everything worth matching on, in one blob. A search engine ranks on
        // this, so a term that only appears in a structured field below would
        // never bring the document back.
        text: [
          record.name,
          record.description ?? undefined,
          language,
          ...technologies,
          record.project_key ?? undefined,
          bandLabel,
          ownerName,
          ...environmentTypes,
        ]
          .filter(Boolean)
          .join(' '),
        // The entity page, not the fleet page: a search result should land on
        // the thing searched for, and that is where its detail lives.
        location: `/catalog/default/component/${record.slug}`,
        slug: record.slug,
        workspace: record.workspace,
        entityRef: record.entity_ref,
        band: score?.band,
        score: score?.total,
        language,
        technologies,
        environments: environmentTypes,
        owner: ownerName,
        ownerConfirmed: false,
        lastCommitAt: record.last_commit_at?.toISOString(),
      };
    }

    this.logger.info(
      `Indexed ${records.length} repositories for search (${latest.size} scored, ${owners.size} with a proposed owner)`,
    );
  }
}
