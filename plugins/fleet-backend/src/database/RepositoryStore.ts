import type { DatabaseService } from '@backstage/backend-plugin-api';
import { toEntityRef } from '../catalog/entityName';
import type { BitbucketRepository } from '../bitbucket/types';

type DatabaseClient = Awaited<ReturnType<DatabaseService['getClient']>>;

/** A repository row as stored. */
export interface RepositoryRecord {
  id: number;
  entity_ref: string;
  workspace: string;
  slug: string;
  name: string;
  description: string | null;
  url: string;
  project_key: string | null;
  default_branch: string | null;
  is_private: boolean;
  language: string | null;
  size_bytes: number | null;
  created_at: Date | null;
  updated_at: Date | null;
  first_seen_at: Date;
  last_synced_at: Date;
  is_live: boolean;
  removed_at: Date | null;
  /** Denormalised from the commit table; see the commit migration for why. */
  last_commit_at: Date | null;
  /** Null until the root listing has been fetched at least once. */
  has_readme: boolean | null;
  root_files: string[] | null;
  /** Derived from manifests. Null until analysis has run. */
  tech_stack: string[] | null;
  /**
   * Language inferred from manifests, kept separate from Bitbucket's own
   * `language` so a derived guess never overwrites source data.
   */
  derived_language: string | null;
  /**
   * Component type and lifecycle inferred from the stack and from what
   * actually deploys. Null until the detail pass has classified the
   * repository, which the entity provider reads as "keep the placeholders".
   */
  derived_type: string | null;
  derived_lifecycle: string | null;
}

/** What one synchronisation pass changed. */
export interface SyncSummary {
  inserted: number;
  updated: number;
  removed: number;
  live: number;
}

/**
 * Columns refreshed on every sync. Deliberately excludes `first_seen_at`, which
 * belongs to the insert only, and `id`.
 */
const MUTABLE_COLUMNS = [
  'name',
  'description',
  'url',
  'project_key',
  'default_branch',
  'is_private',
  'language',
  'size_bytes',
  'created_at',
  'updated_at',
  'last_synced_at',
  'is_live',
  'removed_at',
] as const;

/**
 * Postgres returns `bigint` as a string and SQLite returns booleans as 0/1.
 * Callers should not have to care which database they are on.
 */
function hydrate(row: any): RepositoryRecord {
  return {
    ...row,
    is_private: Boolean(row.is_private),
    is_live: Boolean(row.is_live),
    size_bytes: row.size_bytes === null ? null : Number(row.size_bytes),
    has_readme:
      row.has_readme === null || row.has_readme === undefined
        ? null
        : Boolean(row.has_readme),
    root_files: row.root_files ? JSON.parse(row.root_files) : null,
    tech_stack: row.tech_stack ? JSON.parse(row.tech_stack) : null,
  };
}

/**
 * Persists repository facts.
 *
 * Writes are upserts keyed on Bitbucket's natural identity (workspace + slug),
 * so a sync can be re-run any number of times without creating duplicates --
 * which is what makes the "idempotent processing" requirement true rather than
 * aspirational.
 */
export class RepositoryStore {
  constructor(private readonly db: DatabaseClient) {}

  /**
   * Replaces the known state of a workspace.
   *
   * Repositories absent from `repositories` are marked not-live rather than
   * deleted: commits and pull requests already recorded against them must stay
   * referentially valid, and the disappearance is itself worth recording.
   */
  async syncWorkspace(
    workspace: string,
    repositories: BitbucketRepository[],
    now: Date = new Date(),
  ): Promise<SyncSummary> {
    const before = await this.db<RepositoryRecord>('repository')
      .where({ workspace })
      .select('slug', 'is_live');
    const known = new Set(before.map(r => r.slug));

    for (const repository of repositories) {
      const row = {
        entity_ref: toEntityRef(repository),
        workspace: repository.workspace,
        slug: repository.slug,
        name: repository.name,
        description: repository.description ?? null,
        url: repository.url,
        project_key: repository.projectKey ?? null,
        default_branch: repository.defaultBranch ?? null,
        is_private: repository.isPrivate,
        language: repository.language ?? null,
        size_bytes: repository.sizeBytes ?? null,
        created_at: repository.createdAt
          ? new Date(repository.createdAt)
          : null,
        updated_at: repository.updatedAt
          ? new Date(repository.updatedAt)
          : null,
        last_synced_at: now,
        is_live: true,
        removed_at: null,
      };

      await this.db('repository')
        .insert({ ...row, first_seen_at: now })
        .onConflict(['workspace', 'slug'])
        .merge([...MUTABLE_COLUMNS]);
    }

    const seen = repositories.map(r => r.slug);
    const removed = await this.db('repository')
      .where({ workspace, is_live: true })
      .whereNotIn('slug', seen.length ? seen : [''])
      .update({ is_live: false, removed_at: now });

    return {
      inserted: repositories.filter(r => !known.has(r.slug)).length,
      updated: repositories.filter(r => known.has(r.slug)).length,
      removed,
      live: repositories.length,
    };
  }

  /**
   * Repositories currently present in Bitbucket.
   *
   * Omitting the workspace returns every live repository, which is what the
   * fleet overview needs.
   */
  async listLive(workspace?: string): Promise<RepositoryRecord[]> {
    const query = this.db<RepositoryRecord>('repository').where({
      is_live: true,
    });
    if (workspace) query.andWhere({ workspace });
    const rows = await query.orderBy('slug');
    return rows.map(hydrate);
  }

  /** Looks a repository up by the key shared with the catalog. */
  async findById(id: number): Promise<RepositoryRecord | undefined> {
    const row = await this.db<RepositoryRecord>('repository')
      .where({ id })
      .first();
    return row ? hydrate(row) : undefined;
  }

  async findByEntityRef(
    entityRef: string,
  ): Promise<RepositoryRecord | undefined> {
    const row = await this.db<RepositoryRecord>('repository')
      .where({ entity_ref: entityRef })
      .first();
    return row ? hydrate(row) : undefined;
  }

  /**
   * Records the newest commit seen for a repository.
   *
   * Denormalised deliberately: 'Last Commit Date' is rendered per row in
   * fleet-wide listings, and an aggregate over the commit table per row is what
   * the two-second budget cannot afford.
   */
  async setLastCommitAt(repositoryId: number, at: Date): Promise<void> {
    await this.db('repository')
      .where({ id: repositoryId })
      .update({ last_commit_at: at });
  }

  /**
   * Records the repository's root listing.
   *
   * Stored whole rather than as individual flags so manifest parsing can reuse
   * it without paying for a second pass over the estate.
   */
  async setRootFiles(repositoryId: number, files: string[]): Promise<void> {
    const hasReadme = files.some(f => /^readme(\.|$)/i.test(f));
    await this.db('repository')
      .where({ id: repositoryId })
      .update({ has_readme: hasReadme, root_files: JSON.stringify(files) });
  }

  /**
   * Records the technology stack derived from this repository's manifests.
   *
   * Stored alongside, never over, Bitbucket's own `language`: one is measured
   * at source and the other is inferred, and conflating them would make it
   * impossible to tell which a given value came from.
   */
  async setTechStack(
    repositoryId: number,
    stack: string[],
    language: string | undefined,
  ): Promise<void> {
    await this.db('repository')
      .where({ id: repositoryId })
      .update({
        tech_stack: JSON.stringify(stack),
        derived_language: language ?? null,
      });
  }

  async setClassification(
    repositoryId: number,
    classification: { type: string; lifecycle: string },
  ): Promise<void> {
    await this.db('repository').where({ id: repositoryId }).update({
      derived_type: classification.type,
      derived_lifecycle: classification.lifecycle,
    });
  }

  /**
   * Derived type and lifecycle for a workspace, keyed by slug.
   *
   * Keyed by slug because the caller is the catalog entity provider, which
   * knows repositories by slug and never sees fleet's ids. Rows with no
   * classification yet are omitted rather than returned as `unknown`, so the
   * provider can tell "not classified" from "classified as unknown".
   */
  async classificationForWorkspace(
    workspace: string,
  ): Promise<
    Map<string, { type: string; lifecycle: string; language?: string }>
  > {
    const rows = (await this.db('repository')
      .where({ workspace, is_live: true })
      .whereNotNull('derived_type')
      .whereNotNull('derived_lifecycle')
      .select(
        'slug',
        'derived_type',
        'derived_lifecycle',
        // Carried alongside the classification because it comes from the same
        // pass and the entity provider needs it for the language tag.
        // Bitbucket detects a language for only 6 of 96 repositories; this is
        // inferred from manifests and covers 43.
        'derived_language',
      )) as Array<{
      slug: string;
      derived_type: string;
      derived_lifecycle: string;
      derived_language: string | null;
    }>;

    return new Map(
      rows.map(row => [
        row.slug,
        {
          type: row.derived_type,
          lifecycle: row.derived_lifecycle,
          language: row.derived_language ?? undefined,
        },
      ]),
    );
  }

  /** Total rows, live and removed. Used by tests and diagnostics. */
  async count(workspace: string): Promise<{ live: number; removed: number }> {
    const rows = await this.db<RepositoryRecord>('repository')
      .where({ workspace })
      .select('is_live');
    return {
      live: rows.filter(r => r.is_live).length,
      removed: rows.filter(r => !r.is_live).length,
    };
  }
}
