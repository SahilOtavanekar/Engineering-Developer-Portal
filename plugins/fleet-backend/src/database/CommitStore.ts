import type { DatabaseService } from '@backstage/backend-plugin-api';
import type { BitbucketCommit } from '../bitbucket/types';

type DatabaseClient = Awaited<ReturnType<DatabaseService['getClient']>>;

export interface CommitRecord {
  id: number;
  repository_id: number;
  hash: string;
  committed_at: Date;
  message: string | null;
  author_raw: string | null;
  author_name: string | null;
  author_email: string | null;
  author_account_id: string | null;
  parent_count: number;
}

export interface RepositoryActivity {
  /** Commits in the window, merges excluded. */
  commits: number;
  /** Distinct author emails in the window, merges excluded. */
  authors: number;
  lastCommitAt: Date | null;
}

/** Inserted in batches; SQLite caps bound parameters per statement. */
const INSERT_CHUNK = 200;

/**
 * Persists commits.
 *
 * Writes ignore conflicts on (repository_id, hash) rather than merging: a
 * commit is immutable once written, so re-ingesting an overlapping window is a
 * no-op instead of a pointless rewrite.
 */
export class CommitStore {
  constructor(private readonly db: DatabaseClient) {}

  async insertMany(
    repositoryId: number,
    commits: BitbucketCommit[],
  ): Promise<number> {
    if (commits.length === 0) return 0;

    const rows = commits.map(commit => ({
      repository_id: repositoryId,
      hash: commit.hash,
      committed_at: new Date(commit.committedAt),
      message: commit.message ?? null,
      author_raw: commit.authorRaw ?? null,
      author_name: commit.authorName ?? null,
      author_email: commit.authorEmail ?? null,
      author_account_id: commit.authorAccountId ?? null,
      parent_count: commit.parentCount,
    }));

    // Which of these do we already have? Drivers disagree on what an ignored
    // insert reports -- SQLite returns a single rowid however many rows were
    // supplied -- so the count is established here rather than inferred from
    // the write.
    const hashes = rows.map(r => r.hash);
    const existing = new Set<string>();
    for (let i = 0; i < hashes.length; i += INSERT_CHUNK) {
      const found = await this.db('commit')
        .where({ repository_id: repositoryId })
        .whereIn('hash', hashes.slice(i, i + INSERT_CHUNK))
        .pluck('hash');
      found.forEach((h: string) => existing.add(h));
    }

    const fresh = rows.filter(r => !existing.has(r.hash));
    for (let i = 0; i < fresh.length; i += INSERT_CHUNK) {
      await this.db('commit')
        .insert(fresh.slice(i, i + INSERT_CHUNK))
        // Still guarded, in case a concurrent pass wrote the same commit.
        .onConflict(['repository_id', 'hash'])
        .ignore();
    }
    return fresh.length;
  }

  /** Newest commit timestamp, or null for a repository with no commits. */
  async latestCommitAt(repositoryId: number): Promise<Date | null> {
    const row = await this.db('commit')
      .where({ repository_id: repositoryId })
      .max({ latest: 'committed_at' })
      .first();
    const latest = (row as any)?.latest;
    return latest ? new Date(latest) : null;
  }

  async count(repositoryId: number): Promise<number> {
    const row = await this.db('commit')
      .where({ repository_id: repositoryId })
      .count({ n: '*' })
      .first();
    return Number((row as any)?.n ?? 0);
  }

  /**
   * Activity within a window. Merge commits are excluded from both counts --
   * a merge is not authorship, and counting it as such inflates every metric
   * that section 6 derives from this.
   */
  async activitySince(
    repositoryId: number,
    since: Date,
  ): Promise<RepositoryActivity> {
    const rows = await this.db<CommitRecord>('commit')
      .where({ repository_id: repositoryId })
      .where('committed_at', '>=', since)
      .where('parent_count', '<', 2)
      .select('author_email');

    const authors = new Set(
      rows.map(r => r.author_email).filter((e): e is string => Boolean(e)),
    );

    return {
      commits: rows.length,
      authors: authors.size,
      lastCommitAt: await this.latestCommitAt(repositoryId),
    };
  }
}
