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

/**
 * Bitbucket's own address for pipeline and app commits, e.g.
 * `7gxtj5eq...@bots.bitbucket.org`. A bot writes code but does not own it, and
 * on a repository where automation is the busiest committer it would otherwise
 * be proposed as the owner.
 */
const BOT_EMAIL_PATTERN = '%@bots.bitbucket.org';

/** One author's contribution to a repository over a window. */
export interface AuthorContribution {
  name?: string;
  email?: string;
  accountId?: string;
  commits: number;
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

  /**
   * Who committed most within a window, busiest first.
   *
   * Grouped by email rather than by name: the same person commits as "Ada
   * Lovelace" and "ada" and "Ada L" depending on which machine they were on,
   * and splitting one author into three would hide the very concentration this
   * is looking for. Commits with no email at all are dropped -- they cannot be
   * attributed to anyone, and guessing from the display name would merge
   * distinct people who happen to share a first name.
   *
   * Merge commits are excluded, for the same reason as everywhere else here: a
   * merge is not authorship, and whoever presses the button on a busy
   * repository would otherwise look like its owner. Bot accounts are excluded
   * too -- see {@link BOT_EMAIL_PATTERN}.
   */
  async topAuthorsSince(
    repositoryId: number,
    since: Date,
    limit = 5,
  ): Promise<AuthorContribution[]> {
    const rows = (await this.db('commit')
      .where({ repository_id: repositoryId })
      .where('committed_at', '>=', since)
      .where('parent_count', '<', 2)
      .whereNotNull('author_email')
      .whereNot('author_email', 'like', BOT_EMAIL_PATTERN)
      .groupBy('author_email')
      .select('author_email')
      .count({ commits: '*' })
      .orderBy('commits', 'desc')
      .orderBy('author_email', 'asc')
      .limit(limit)) as Array<{
      author_email: string;
      commits: number | string;
    }>;

    // A display name and account id are wanted alongside the count, but they
    // are per-commit and grouping cannot carry them. One extra query for the
    // handful of emails that survived the limit is cheaper than joining.
    const emails = rows.map(row => row.author_email);
    const identities = new Map<string, { name?: string; accountId?: string }>();
    if (emails.length > 0) {
      const detail = (await this.db<CommitRecord>('commit')
        .where({ repository_id: repositoryId })
        .whereIn('author_email', emails)
        .orderBy('committed_at', 'desc')
        .select(
          'author_email',
          'author_name',
          'author_account_id',
        )) as CommitRecord[];

      // Newest first, so the identity kept is the one they used most recently.
      for (const row of detail) {
        const email = row.author_email;
        if (!email || identities.has(email)) continue;
        identities.set(email, {
          name: row.author_name ?? undefined,
          accountId: row.author_account_id ?? undefined,
        });
      }
    }

    return rows.map(row => ({
      email: row.author_email,
      commits: Number(row.commits),
      name: identities.get(row.author_email)?.name,
      accountId: identities.get(row.author_email)?.accountId,
    }));
  }

  /**
   * Commits in the window that could be attributed to a person.
   *
   * The denominator for an authorship share, and deliberately not
   * {@link activitySince}'s count: that one counts everything, because
   * "how busy is this repository" includes bot and unattributed commits. A
   * share of ownership measured against those would understate whoever
   * actually wrote the code.
   */
  async attributedCommitsSince(
    repositoryId: number,
    since: Date,
  ): Promise<number> {
    const row = await this.db('commit')
      .where({ repository_id: repositoryId })
      .where('committed_at', '>=', since)
      .where('parent_count', '<', 2)
      .whereNotNull('author_email')
      .whereNot('author_email', 'like', BOT_EMAIL_PATTERN)
      .count({ n: '*' })
      .first();
    return Number((row as any)?.n ?? 0);
  }
}
