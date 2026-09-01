import type { DatabaseService } from '@backstage/backend-plugin-api';
import type { BitbucketCommit } from '../bitbucket/types';
import type {
  BranchPolicySummary,
  ClassifiedCommit,
  CommitNode,
} from '../analysis/branchPolicy';

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
      // First parent first; the chain walk depends on that order.
      parents: commit.parents?.length ? commit.parents.join(',') : null,
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

  /**
   * Every stored commit as a graph node, newest first.
   *
   * Newest first because the classifier starts at the branch tip and follows
   * first parents; the order is load-bearing, not cosmetic.
   */
  async graph(repositoryId: number): Promise<CommitNode[]> {
    const rows = (await this.db('commit')
      .where({ repository_id: repositoryId })
      .orderBy('committed_at', 'desc')
      .orderBy('id', 'desc')
      .select('hash', 'parents')) as Array<{
      hash: string;
      parents: string | null;
    }>;

    return rows.map(row => ({
      hash: row.hash,
      parents: row.parents ? row.parents.split(',').filter(Boolean) : [],
    }));
  }

  /**
   * How many stored commits are missing parent hashes.
   *
   * Must be zero before the branch policy can be computed, and "at least one
   * has them" is not good enough: the walk follows first parents from the tip,
   * so it stops dead at the first commit without them and reports a mainline
   * far shorter than the truth. Commits ingested before the `parents` column
   * existed have none, and the incremental watermark means they never acquire
   * any -- those repositories must be skipped, not half-measured.
   */
  async commitsMissingParents(repositoryId: number): Promise<number> {
    const [row] = (await this.db('commit')
      .where({ repository_id: repositoryId })
      .whereNull('parents')
      // A root commit legitimately has no parents; it is stored as null and
      // would otherwise block its repository for ever.
      .where('parent_count', '>', 0)
      .count({ n: '*' })) as Array<{ n: string | number }>;
    return Number(row?.n ?? 0);
  }

  /**
   * Writes how each commit reached the branch.
   *
   * Chunked and keyed by hash rather than done with one statement per commit:
   * the busiest repository here has 524 commits, and a statement each would be
   * 524 round trips per pass.
   */
  async recordArrivals(
    repositoryId: number,
    classified: ClassifiedCommit[],
  ): Promise<number> {
    if (classified.length === 0) return 0;

    // Group by the value being written so each distinct combination is one
    // statement, not one per commit. There are only ever four.
    const groups = new Map<string, string[]>();
    for (const commit of classified) {
      const key = `${commit.onMainline ? 1 : 0}:${commit.arrival}`;
      const list = groups.get(key);
      if (list) list.push(commit.hash);
      else groups.set(key, [commit.hash]);
    }

    let written = 0;
    for (const [key, hashes] of groups) {
      const [mainline, arrival] = key.split(':');
      for (let i = 0; i < hashes.length; i += INSERT_CHUNK) {
        written += await this.db('commit')
          .where({ repository_id: repositoryId })
          .whereIn('hash', hashes.slice(i, i + INSERT_CHUNK))
          .update({ on_mainline: mainline === '1', arrival });
      }
    }
    return written;
  }

  /**
   * How commits reached the default branch within a window.
   *
   * Counts from the stored classification rather than recomputing the walk, so
   * any window is a single aggregate and the reporting period can change
   * without re-reading Bitbucket.
   */
  async branchPolicySince(
    repositoryId: number,
    since: Date,
  ): Promise<BranchPolicySummary & { classified: number }> {
    const rows = (await this.db('commit')
      .where({ repository_id: repositoryId })
      .where('committed_at', '>=', since)
      .whereNotNull('arrival')
      .groupBy('arrival')
      .select('arrival')
      .count({ n: '*' })) as Array<{ arrival: string; n: string | number }>;

    const of = (arrival: string) =>
      Number(rows.find(row => row.arrival === arrival)?.n ?? 0);

    const viaPullRequest = of('pull-request');
    const direct = of('direct');
    const directMerge = of('direct-merge');
    const mergedIn = of('merged-in');

    return {
      mainline: viaPullRequest + direct + directMerge,
      viaPullRequest,
      direct,
      directMerge,
      mergedIn,
      classified: viaPullRequest + direct + directMerge + mergedIn,
    };
  }

  /**
   * Branch-policy counts for a whole workspace, keyed by slug.
   *
   * One query for the estate. The entity provider needs this for all 95
   * repositories at once, and a lookup per repository would be an N+1 that is
   * invisible here and ruinous at the 10,000 the document imagines.
   *
   * A slug absent from the map means the classification pass has not reached it.
   */
  async branchPolicyForWorkspace(
    workspace: string,
    since: Date,
  ): Promise<Map<string, BranchPolicySummary>> {
    const rows = (await this.db('commit')
      .join('repository', 'repository.id', 'commit.repository_id')
      .where('repository.workspace', workspace)
      .where('repository.is_live', true)
      .where('commit.committed_at', '>=', since)
      .whereNotNull('commit.arrival')
      .groupBy('repository.slug', 'commit.arrival')
      .select('repository.slug as slug', 'commit.arrival as arrival')
      .count({ n: '*' })) as Array<{
      slug: string;
      arrival: string;
      n: string | number;
    }>;

    const bySlug = new Map<string, BranchPolicySummary>();
    for (const row of rows) {
      const current =
        bySlug.get(row.slug) ??
        ({
          mainline: 0,
          viaPullRequest: 0,
          direct: 0,
          directMerge: 0,
          mergedIn: 0,
        } as BranchPolicySummary);
      const n = Number(row.n);
      if (row.arrival === 'pull-request') current.viaPullRequest += n;
      else if (row.arrival === 'direct') current.direct += n;
      else if (row.arrival === 'direct-merge') current.directMerge += n;
      else if (row.arrival === 'merged-in') current.mergedIn += n;
      current.mainline =
        current.viaPullRequest + current.direct + current.directMerge;
      bySlug.set(row.slug, current);
    }
    return bySlug;
  }

  /**
   * Lifetime commit counts for a workspace, keyed by repository id.
   *
   * One query for the estate. Dormancy classification needs it -- a repository
   * with 276 commits and none recently is abandoned, one with four was never
   * developed -- and the overview endpoint judges all 96 at once, so a
   * per-repository lookup would be an N+1 in the endpoint the two-second page
   * load depends on.
   */
  async lifetimeCommitsForWorkspace(
    workspace: string,
  ): Promise<Map<number, number>> {
    const rows = (await this.db('commit')
      .join('repository', 'repository.id', 'commit.repository_id')
      .where('repository.workspace', workspace)
      .where('repository.is_live', true)
      .groupBy('commit.repository_id')
      .select('commit.repository_id as id')
      .count({ n: '*' })) as Array<{ id: number; n: string | number }>;

    return new Map(rows.map(row => [Number(row.id), Number(row.n)]));
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
   * Facts about a repository's whole life, not a window.
   *
   * These are what distinguish an abandoned mature service from a repository
   * somebody created and pushed to twice -- `chat-widget` has two commits in
   * total, and until history was ingested it looked identical to the former.
   *
   * Every scored metric windows explicitly, so nothing here feeds a score.
   */
  /**
   * The earliest commit on record, and who authored it.
   *
   * The only available answer to "who created this repository". Verified
   * against the live API on 2026-09-01: the Bitbucket repository object exposes
   * `owner`, but for a workspace repository that is the workspace itself
   * (`{"type":"team","display_name":"DemandAI"}`) -- there is no `creator`,
   * `created_by` or `author` field anywhere on it.
   *
   * Merges are excluded, as everywhere else here; a repository's first commit
   * is never one. Bots are **not** excluded: if a bot really did push first,
   * that is the fact, and the caller can say so rather than skipping to the
   * first human and presenting them as the creator.
   */
  async firstCommit(repositoryId: number): Promise<
    | {
        email?: string;
        name?: string;
        committedAt: Date;
      }
    | undefined
  > {
    const row = (await this.db('commit')
      .where({ repository_id: repositoryId })
      .where('parent_count', '<', 2)
      .orderBy('committed_at', 'asc')
      .orderBy('id', 'asc')
      .first('author_email', 'author_name', 'committed_at')) as
      | {
          author_email: string | null;
          author_name: string | null;
          committed_at: Date | string;
        }
      | undefined;

    if (!row) return undefined;
    return {
      email: row.author_email ?? undefined,
      name: row.author_name ?? undefined,
      committedAt: new Date(row.committed_at),
    };
  }

  /**
   * The earliest commit per repository, for the whole estate.
   *
   * Batched because the fleet overview shows a creator on every row, and a
   * per-repository lookup would be an N+1 in the one endpoint the two-second
   * page load depends on.
   *
   * Joined against a grouped `min(committed_at)` rather than `distinct on`,
   * which is Postgres-only -- the unit tests run this against SQLite. Two
   * commits sharing the earliest timestamp would both come back; the first
   * wins, deterministically, because the query is ordered by id.
   */
  async firstCommitForRepositories(
    repositoryIds: number[],
  ): Promise<
    Map<number, { email?: string; name?: string; committedAt: Date }>
  > {
    if (repositoryIds.length === 0) return new Map();

    const earliest = this.db('commit')
      .whereIn('repository_id', repositoryIds)
      .where('parent_count', '<', 2)
      .groupBy('repository_id')
      .select('repository_id')
      .min({ first_at: 'committed_at' })
      .as('f');

    const rows = (await this.db({ c: 'commit' })
      .join(earliest, function joinOnEarliest() {
        this.on('f.repository_id', '=', 'c.repository_id').andOn(
          'f.first_at',
          '=',
          'c.committed_at',
        );
      })
      .where('c.parent_count', '<', 2)
      .orderBy('c.id', 'asc')
      .select(
        'c.repository_id',
        'c.author_email',
        'c.author_name',
        'c.committed_at',
      )) as Array<{
      repository_id: number;
      author_email: string | null;
      author_name: string | null;
      committed_at: Date | string | number;
    }>;

    const first = new Map<
      number,
      { email?: string; name?: string; committedAt: Date }
    >();
    for (const row of rows) {
      const id = Number(row.repository_id);
      if (first.has(id)) continue;
      first.set(id, {
        email: row.author_email ?? undefined,
        name: row.author_name ?? undefined,
        committedAt: new Date(row.committed_at),
      });
    }
    return first;
  }

  /**
   * Commit authors per repository inside a window, for the whole estate.
   *
   * One grouped query rather than `topAuthorsSince` per repository. Display
   * names are deliberately not fetched: the caller resolves addresses through
   * the identity register, which is the thing that decides who someone is --
   * a commit's `author_name` is whatever the committer put in their git config
   * and is unreliable enough that the register exists to override it.
   */
  async contributorsForRepositories(
    repositoryIds: number[],
    since: Date,
  ): Promise<Map<number, Array<{ email: string; commits: number }>>> {
    if (repositoryIds.length === 0) return new Map();

    const rows = (await this.db('commit')
      .whereIn('repository_id', repositoryIds)
      .where('committed_at', '>=', since)
      .where('parent_count', '<', 2)
      .whereNotNull('author_email')
      .whereNot('author_email', 'like', BOT_EMAIL_PATTERN)
      .groupBy('repository_id', 'author_email')
      .select('repository_id', 'author_email')
      .count({ commits: '*' })) as Array<{
      repository_id: number;
      author_email: string;
      commits: number | string;
    }>;

    const byRepository = new Map<
      number,
      Array<{ email: string; commits: number }>
    >();
    for (const row of rows) {
      const id = Number(row.repository_id);
      const list = byRepository.get(id) ?? [];
      list.push({ email: row.author_email, commits: Number(row.commits) });
      byRepository.set(id, list);
    }
    for (const list of byRepository.values()) {
      list.sort(
        (a, b) => b.commits - a.commits || a.email.localeCompare(b.email),
      );
    }
    return byRepository;
  }

  async lifetime(repositoryId: number): Promise<{
    commits: number;
    authors: number;
    firstCommitAt?: Date;
    lastCommitAt?: Date;
  }> {
    const row = (await this.db('commit')
      .where({ repository_id: repositoryId })
      .where('parent_count', '<', 2)
      .select(
        this.db.raw('count(*) as commits'),
        this.db.raw('count(distinct author_email) as authors'),
        this.db.raw('min(committed_at) as first_at'),
        this.db.raw('max(committed_at) as last_at'),
      )
      .first()) as any;

    return {
      commits: Number(row?.commits ?? 0),
      authors: Number(row?.authors ?? 0),
      firstCommitAt: row?.first_at ? new Date(row.first_at) : undefined,
      lastCommitAt: row?.last_at ? new Date(row.last_at) : undefined,
    };
  }

  /**
   * Every distinct commit author across a workspace, with a display name.
   *
   * Used to join a Bitbucket display name to an email address -- repository
   * permissions name people but carry no email. Not windowed: an admin who
   * last committed a year ago still needs their address resolved.
   */
  async distinctAuthors(
    workspace: string,
  ): Promise<Array<{ name?: string; email: string }>> {
    const rows = (await this.db('commit')
      .join('repository', 'repository.id', 'commit.repository_id')
      .where('repository.workspace', workspace)
      .whereNotNull('commit.author_email')
      .whereNot('commit.author_email', 'like', BOT_EMAIL_PATTERN)
      .orderBy('commit.committed_at', 'desc')
      .select(
        'commit.author_email as author_email',
        'commit.author_name as author_name',
      )) as Array<{ author_email: string; author_name: string | null }>;

    const byEmail = new Map<string, { name?: string; email: string }>();
    for (const row of rows) {
      if (byEmail.has(row.author_email)) continue;
      byEmail.set(row.author_email, {
        email: row.author_email,
        name: row.author_name ?? undefined,
      });
    }
    return [...byEmail.values()];
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
