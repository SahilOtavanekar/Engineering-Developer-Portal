import type { DatabaseService } from '@backstage/backend-plugin-api';
import type { OwnershipCandidate, OwnershipProposal } from '../ownership/types';

type DatabaseClient = Awaited<ReturnType<DatabaseService['getClient']>>;

/** Maps one `ownership_candidate` row onto the domain type. */
function hydrate(row: Record<string, any>): StoredOwnershipCandidate {
  return {
    rank: Number(row.rank),
    // SQLite hands booleans back as 0/1.
    isProposed: Boolean(row.is_proposed),
    name: row.author_name ?? undefined,
    email: row.author_email ?? undefined,
    accountId: row.author_account_id ?? undefined,
    commits: Number(row.commits),
    windowCommits: Number(row.window_commits),
    windowDays: Number(row.window_days),
    source: row.source,
    resolvedAt: new Date(row.resolved_at),
  };
}

/** A stored candidate, with the evidence needed to confirm or reject it. */
export interface StoredOwnershipCandidate extends OwnershipCandidate {
  rank: number;
  /** The resolver was confident enough to put this name forward. */
  isProposed: boolean;
  windowCommits: number;
  windowDays: number;
  source: string;
  resolvedAt: Date;
}

/**
 * Derived ownership candidates, replaced per repository on each pass.
 *
 * Deliberately not history. A score is a measurement of a moment and is worth
 * keeping a series of; a candidate owner is a current best guess, and an old
 * guess is of no use to anyone.
 */
export class OwnershipStore {
  constructor(private readonly db: DatabaseClient) {}

  async replaceForRepository(
    repositoryId: number,
    proposal: OwnershipProposal,
    source: string,
    now: Date = new Date(),
  ): Promise<number> {
    await this.db('ownership_candidate')
      .where({ repository_id: repositoryId })
      .delete();

    if (proposal.candidates.length === 0) return 0;

    // Matched on email, which is what the candidates were grouped by.
    const proposedEmail = proposal.proposed?.email;

    const rows = proposal.candidates.map((candidate, index) => ({
      repository_id: repositoryId,
      rank: index + 1,
      is_proposed:
        proposedEmail !== undefined && candidate.email === proposedEmail,
      author_name: candidate.name ?? null,
      author_email: candidate.email ?? null,
      author_account_id: candidate.accountId ?? null,
      commits: candidate.commits,
      window_commits: proposal.windowCommits,
      window_days: proposal.windowDays,
      source,
      resolved_at: now,
    }));

    await this.db('ownership_candidate').insert(rows);
    return rows.length;
  }

  /** Strongest first. Empty when nothing has been resolved yet. */
  async forRepository(
    repositoryId: number,
  ): Promise<StoredOwnershipCandidate[]> {
    const rows = (await this.db('ownership_candidate')
      .where({ repository_id: repositoryId })
      .orderBy('rank', 'asc')) as Array<{
      rank: number;
      is_proposed: boolean | number;
      author_name: string | null;
      author_email: string | null;
      author_account_id: string | null;
      commits: number | string;
      window_commits: number | string;
      window_days: number | string;
      source: string;
      resolved_at: Date;
    }>;

    return rows.map(hydrate);
  }

  /**
   * The confident proposal for every repository in a workspace, keyed by slug.
   *
   * Keyed by slug rather than id because the caller is the catalog entity
   * provider, which knows repositories by slug and never sees fleet's ids.
   */
  async proposedForWorkspace(
    workspace: string,
  ): Promise<Map<string, StoredOwnershipCandidate>> {
    const rows = (await this.db('ownership_candidate')
      .join('repository', 'repository.id', 'ownership_candidate.repository_id')
      .where('repository.workspace', workspace)
      .where('repository.is_live', true)
      .where('ownership_candidate.is_proposed', true)
      .select(
        'repository.slug as slug',
        'ownership_candidate.rank as rank',
        'ownership_candidate.is_proposed as is_proposed',
        'ownership_candidate.author_name as author_name',
        'ownership_candidate.author_email as author_email',
        'ownership_candidate.author_account_id as author_account_id',
        'ownership_candidate.commits as commits',
        'ownership_candidate.window_commits as window_commits',
        'ownership_candidate.window_days as window_days',
        'ownership_candidate.source as source',
        'ownership_candidate.resolved_at as resolved_at',
      )) as Array<Record<string, any>>;

    return new Map(rows.map(row => [row.slug as string, hydrate(row)]));
  }

  /** Confident proposals for a set of repositories, keyed by repository id. */
  async proposedForRepositories(
    repositoryIds: number[],
  ): Promise<Map<number, StoredOwnershipCandidate>> {
    if (repositoryIds.length === 0) return new Map();

    const rows = (await this.db('ownership_candidate')
      .whereIn('repository_id', repositoryIds)
      .where('is_proposed', true)) as Array<Record<string, any>>;

    return new Map(rows.map(row => [Number(row.repository_id), hydrate(row)]));
  }

  /**
   * Everyone who appears as a candidate anywhere in a workspace, deduplicated
   * by email.
   *
   * The set of people the portal has something to say about, which is what it
   * is willing to create a catalog User for. Creating one for every commit
   * author would add names the portal never references.
   */
  async candidateAuthors(
    workspace: string,
  ): Promise<Array<{ name?: string; email: string; accountId?: string }>> {
    const rows = (await this.db('ownership_candidate')
      .join('repository', 'repository.id', 'ownership_candidate.repository_id')
      .where('repository.workspace', workspace)
      .where('repository.is_live', true)
      .whereNotNull('ownership_candidate.author_email')
      .orderBy('ownership_candidate.commits', 'desc')
      .select(
        'ownership_candidate.author_email as author_email',
        'ownership_candidate.author_name as author_name',
        'ownership_candidate.author_account_id as author_account_id',
      )) as Array<{
      author_email: string;
      author_name: string | null;
      author_account_id: string | null;
    }>;

    const byEmail = new Map<
      string,
      { name?: string; email: string; accountId?: string }
    >();
    // Busiest first, so the identity kept for someone who commits under
    // several display names is the one from their largest contribution.
    for (const row of rows) {
      if (byEmail.has(row.author_email)) continue;
      byEmail.set(row.author_email, {
        email: row.author_email,
        name: row.author_name ?? undefined,
        accountId: row.author_account_id ?? undefined,
      });
    }
    return [...byEmail.values()];
  }

  async count(repositoryId: number): Promise<number> {
    const row = await this.db('ownership_candidate')
      .where({ repository_id: repositoryId })
      .count({ n: '*' })
      .first();
    return Number((row as any)?.n ?? 0);
  }
}
