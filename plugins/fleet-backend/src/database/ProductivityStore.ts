import type { DatabaseService } from '@backstage/backend-plugin-api';
import type { TrendBucket } from '@internal/backstage-plugin-fleet-common';

type DatabaseClient = Awaited<ReturnType<DatabaseService['getClient']>>;

/** What every productivity query is scoped by. */
export interface ProductivityWindow {
  workspace: string;
  /** Inclusive lower bound. */
  since: Date;
  /** Exclusive upper bound. Absent means up to now. */
  until?: Date;
  /** Restrict to one repository, by slug. */
  repositorySlug?: string;
}

export interface CommitsByAuthorRow {
  /** Raw address as committed. Resolved to a person by the caller. */
  email: string;
  commits: number;
  repositories: number;
  lastCommitAt: Date | null;
}

export interface CommitTrendRow {
  email: string;
  /** Start of the bucket, UTC. Its size depends on the window's length. */
  start: Date;
  commits: number;
}

/** One repository one person committed to inside the window. */
export interface AuthorRepositoryRow {
  email: string;
  slug: string;
  commits: number;
}

/** The only units accepted into the trend query's raw SQL fragment. */
const TREND_BUCKETS: TrendBucket[] = ['day', 'week', 'month'];

export interface AuthoredPullRequestRow {
  /** Bitbucket display name. Pull requests carry no address. */
  name: string;
  created: number;
  merged: number;
  /** Mean hours from opening to close, over merged pull requests only. */
  averageMergeHours: number | null;
}

export interface ParticipationRow {
  name: string;
  /** Pull requests they took part in at all. */
  reviewed: number;
  /** Of those, how many they approved. */
  approved: number;
}

export interface MergedByRow {
  name: string;
  merged: number;
}

/**
 * Per-engineer aggregates for the productivity dashboard.
 *
 * Every query groups by the **raw** key Bitbucket supplied -- an address for
 * commits, a display name for pull requests -- and leaves identity resolution to
 * the caller. That split is deliberate: this estate has 29 addresses for 22
 * humans, and the mapping between them lives in one place (the identity
 * register) rather than being half-expressed in SQL where it would drift.
 *
 * All aggregation happens in the database. Pulling 3,954 commits into Node to
 * count them per person would work at this size and not at the 1,000,000 the
 * document imagines.
 */
export class ProductivityStore {
  constructor(private readonly db: DatabaseClient) {}

  /** Applies the window to a query already joined to `repository`. */
  private scope(query: any, window: ProductivityWindow, dateColumn: string) {
    query
      .where('repository.workspace', window.workspace)
      .where('repository.is_live', true)
      .where(dateColumn, '>=', window.since);
    if (window.until) query.where(dateColumn, '<', window.until);
    if (window.repositorySlug) {
      query.where('repository.slug', window.repositorySlug);
    }
    return query;
  }

  async commitsByAuthor(
    window: ProductivityWindow,
  ): Promise<CommitsByAuthorRow[]> {
    const query = this.db('commit')
      .join('repository', 'repository.id', 'commit.repository_id')
      .whereNotNull('commit.author_email')
      .groupBy('commit.author_email')
      .select('commit.author_email as email')
      .count({ commits: '*' })
      .countDistinct({ repositories: 'commit.repository_id' })
      .max({ last: 'commit.committed_at' });

    const rows = (await this.scope(
      query,
      window,
      'commit.committed_at',
    )) as Array<{
      email: string;
      commits: string | number;
      repositories: string | number;
      last: Date | string | null;
    }>;

    return rows.map(row => ({
      email: row.email,
      commits: Number(row.commits),
      repositories: Number(row.repositories),
      lastCommitAt: row.last ? new Date(row.last) : null,
    }));
  }

  /**
   * Commits per author per month.
   *
   * `date_trunc` rather than formatting to a string: the caller needs to sort
   * and bucket these, and '2026-1' sorts after '2026-10' as text.
   */
  async commitTrendByAuthor(
    window: ProductivityWindow,
    bucket: TrendBucket = 'month',
  ): Promise<CommitTrendRow[]> {
    // Chosen from a closed set, never interpolated from anything a caller
    // supplies: this lands inside a raw SQL fragment.
    const unit: TrendBucket = TREND_BUCKETS.includes(bucket) ? bucket : 'month';
    const truncated = `date_trunc('${unit}', commit.committed_at)`;

    const query = this.db('commit')
      .join('repository', 'repository.id', 'commit.repository_id')
      .whereNotNull('commit.author_email')
      .groupBy('commit.author_email')
      .groupByRaw(truncated)
      .select('commit.author_email as email')
      .select(this.db.raw(`${truncated} as bucket_start`))
      .count({ commits: '*' });

    const rows = (await this.scope(
      query,
      window,
      'commit.committed_at',
    )) as Array<{
      email: string;
      bucket_start: Date | string;
      commits: string | number;
    }>;

    return rows.map(row => ({
      email: row.email,
      start: new Date(row.bucket_start),
      commits: Number(row.commits),
    }));
  }

  /**
   * Which repositories each person committed to, and how much.
   *
   * One grouped query for the estate -- 107 author-repository pairs over 90
   * days here, so the whole breakdown travels with the overview rather than
   * needing a request per engineer.
   */
  async repositoriesByAuthor(
    window: ProductivityWindow,
  ): Promise<AuthorRepositoryRow[]> {
    const query = this.db('commit')
      .join('repository', 'repository.id', 'commit.repository_id')
      .whereNotNull('commit.author_email')
      .where('commit.parent_count', '<', 2)
      .groupBy('commit.author_email', 'repository.slug')
      .select('commit.author_email as email', 'repository.slug as slug')
      .count({ commits: '*' });

    const rows = (await this.scope(
      query,
      window,
      'commit.committed_at',
    )) as Array<{ email: string; slug: string; commits: string | number }>;

    return rows.map(row => ({
      email: row.email,
      slug: row.slug,
      commits: Number(row.commits),
    }));
  }

  /**
   * Pull requests each person opened, and how long theirs took to merge.
   *
   * Merge duration is measured from `closed_at`, never `updated_at`: the latter
   * moves on any later edit and overstated one merge sevenfold when it was
   * used by mistake.
   */
  async authoredPullRequests(
    window: ProductivityWindow,
  ): Promise<AuthoredPullRequestRow[]> {
    const query = this.db('pull_request')
      .join('repository', 'repository.id', 'pull_request.repository_id')
      .whereNotNull('pull_request.author_name')
      .groupBy('pull_request.author_name')
      .select('pull_request.author_name as name')
      .count({ created: '*' })
      .select(
        this.db.raw(
          `count(*) filter (where pull_request.state = 'MERGED') as merged`,
        ),
      )
      .select(
        this.db.raw(
          `avg(
             extract(epoch from (pull_request.closed_at - pull_request.created_at)) / 3600
           ) filter (
             where pull_request.state = 'MERGED' and pull_request.closed_at is not null
           ) as avg_merge_hours`,
        ),
      );

    const rows = (await this.scope(
      query,
      window,
      'pull_request.created_at',
    )) as Array<{
      name: string;
      created: string | number;
      merged: string | number;
      avg_merge_hours: string | number | null;
    }>;

    return rows.map(row => ({
      name: row.name,
      created: Number(row.created),
      merged: Number(row.merged),
      averageMergeHours:
        row.avg_merge_hours === null ? null : Number(row.avg_merge_hours),
    }));
  }

  /**
   * Pull requests each person took part in, and how many they approved.
   *
   * Keyed on the participant's display name because Bitbucket supplies no
   * address for a participant and `/2.0/users/{account_id}` is 403 for this
   * token. Measured on this estate, every pull request author matched a
   * registered person by name -- but a participant that fails to match is
   * reported by the caller rather than silently dropped.
   */
  async participation(window: ProductivityWindow): Promise<ParticipationRow[]> {
    const query = this.db('pull_request_participant')
      .join(
        'pull_request',
        'pull_request.id',
        'pull_request_participant.pull_request_id',
      )
      .join('repository', 'repository.id', 'pull_request.repository_id')
      .whereNotNull('pull_request_participant.display_name')
      .groupBy('pull_request_participant.display_name')
      .select('pull_request_participant.display_name as name')
      .countDistinct({ reviewed: 'pull_request.id' })
      .select(
        this.db.raw(
          `count(distinct pull_request.id) filter (
             where pull_request_participant.approved = true
           ) as approved`,
        ),
      );

    const rows = (await this.scope(
      query,
      window,
      'pull_request.created_at',
    )) as Array<{
      name: string;
      reviewed: string | number;
      approved: string | number;
    }>;

    return rows.map(row => ({
      name: row.name,
      reviewed: Number(row.reviewed),
      approved: Number(row.approved),
    }));
  }

  /** Pull requests each person merged, whoever wrote them. */
  async mergedBy(window: ProductivityWindow): Promise<MergedByRow[]> {
    const query = this.db('pull_request')
      .join('repository', 'repository.id', 'pull_request.repository_id')
      .where('pull_request.state', 'MERGED')
      .whereNotNull('pull_request.closed_by_name')
      .groupBy('pull_request.closed_by_name')
      .select('pull_request.closed_by_name as name')
      .count({ merged: '*' });

    const rows = (await this.scope(
      query,
      window,
      'pull_request.created_at',
    )) as Array<{ name: string; merged: string | number }>;

    return rows.map(row => ({ name: row.name, merged: Number(row.merged) }));
  }

  /** Repository slugs with any commit in the window, for the filter list. */
  async repositoriesWithActivity(
    window: ProductivityWindow,
  ): Promise<string[]> {
    const query = this.db('commit')
      .join('repository', 'repository.id', 'commit.repository_id')
      .distinct('repository.slug as slug')
      .orderBy('repository.slug');

    const rows = (await this.scope(
      query,
      { ...window, repositorySlug: undefined },
      'commit.committed_at',
    )) as Array<{ slug: string }>;

    return rows.map(row => row.slug);
  }
}
