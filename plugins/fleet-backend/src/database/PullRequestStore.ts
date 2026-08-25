import type { DatabaseService } from '@backstage/backend-plugin-api';
import type { BitbucketPullRequest } from '../bitbucket/types';

type DatabaseClient = Awaited<ReturnType<DatabaseService['getClient']>>;

export interface ReviewSummary {
  /** Merged pull requests inside the window. */
  merged: number;
  /** Of those, how many had at least one approval. */
  approved: number;
  /** Currently open, regardless of window. */
  open: number;
  /**
   * Median hours from opening to merge -- section 6's "average merge duration".
   * Undefined when nothing merged.
   */
  medianMergeHours?: number;
  /**
   * Median hours from opening to the *first* approval -- section 6's "PR review
   * time". A different measurement from merge duration: how long the author
   * waited to be unblocked, rather than how long the change took to land.
   *
   * Undefined when nothing in the window was approved. 55 of 177 sampled merged
   * pull requests had no approval at all, so this is routinely absent.
   */
  medianReviewHours?: number;
}

/** Median of a sorted list, to one decimal. Undefined when empty. */
function median(sorted: number[]): number | undefined {
  if (sorted.length === 0) return undefined;
  return Math.round(sorted[Math.floor(sorted.length / 2)] * 10) / 10;
}

/** Hours between two instants, or undefined if the pair is unusable. */
function hoursBetween(from: Date, to: Date | null): number | undefined {
  if (!to) return undefined;
  const hours = (new Date(to).getTime() - new Date(from).getTime()) / 3_600_000;
  return Number.isFinite(hours) && hours >= 0 ? hours : undefined;
}

const CHUNK = 200;

/**
 * Pull request facts.
 *
 * Appended, not replaced: a merged pull request is immutable history. Open ones
 * are upserted, since their state and approval count change until they close.
 */
export class PullRequestStore {
  constructor(private readonly db: DatabaseClient) {}

  async upsertMany(
    repositoryId: number,
    pullRequests: BitbucketPullRequest[],
  ): Promise<number> {
    if (pullRequests.length === 0) return 0;

    const rows = pullRequests.map(pr => ({
      repository_id: repositoryId,
      pr_id: pr.id,
      title: pr.title ?? null,
      state: pr.state,
      created_at: new Date(pr.createdAt),
      updated_at: new Date(pr.updatedAt),
      comment_count: pr.commentCount,
      approval_count: pr.approvalCount,
      participant_count: pr.participantCount,
      author_account_id: pr.authorAccountId ?? null,
      author_name: pr.authorName ?? null,
      closed_at: pr.closedAt ? new Date(pr.closedAt) : null,
      first_approval_at: pr.firstApprovalAt
        ? new Date(pr.firstApprovalAt)
        : null,
      source_branch: pr.sourceBranch ?? null,
      destination_branch: pr.destinationBranch ?? null,
    }));

    for (let i = 0; i < rows.length; i += CHUNK) {
      await this.db('pull_request')
        .insert(rows.slice(i, i + CHUNK))
        .onConflict(['repository_id', 'pr_id'])
        // State, approvals and comments all move while a PR is open -- and so
        // do both timestamps: an approval arrives mid-review, and `closed_at`
        // only exists once it merges. Omitting them here would leave every
        // pull request that was first seen open without either.
        .merge([
          'title',
          'state',
          'updated_at',
          'closed_at',
          'first_approval_at',
          'comment_count',
          'approval_count',
          'participant_count',
        ]);
    }
    return rows.length;
  }

  /** Newest update time held, used as the incremental watermark. */
  async latestUpdatedAt(repositoryId: number): Promise<Date | null> {
    const row = await this.db('pull_request')
      .where({ repository_id: repositoryId })
      .max({ latest: 'updated_at' })
      .first();
    const latest = (row as any)?.latest;
    return latest ? new Date(latest) : null;
  }

  async count(repositoryId: number): Promise<number> {
    const row = await this.db('pull_request')
      .where({ repository_id: repositoryId })
      .count({ n: '*' })
      .first();
    return Number((row as any)?.n ?? 0);
  }

  async reviewSummary(
    repositoryId: number,
    since: Date,
  ): Promise<ReviewSummary> {
    const merged = (await this.db('pull_request')
      .where({ repository_id: repositoryId, state: 'MERGED' })
      .where('updated_at', '>=', since)
      .select(
        'approval_count',
        'created_at',
        'updated_at',
        'closed_at',
        'first_approval_at',
      )) as Array<{
      approval_count: number;
      created_at: Date;
      updated_at: Date;
      closed_at: Date | null;
      first_approval_at: Date | null;
    }>;

    const openRow = await this.db('pull_request')
      .where({ repository_id: repositoryId, state: 'OPEN' })
      .count({ n: '*' })
      .first();

    // `closed_at` is when it actually merged. Rows ingested before that column
    // existed fall back to `updated_at`, which overstates the duration but is
    // better than dropping them from the median entirely; a re-ingestion
    // replaces the approximation with the real thing.
    const mergeHours = merged
      .map(pr => hoursBetween(pr.created_at, pr.closed_at ?? pr.updated_at))
      .filter((h): h is number => h !== undefined)
      .sort((a, b) => a - b);

    // Only pull requests that were actually approved. Including the
    // unapproved ones as zero would report a review time for reviews that
    // never happened.
    const reviewHours = merged
      .map(pr => hoursBetween(pr.created_at, pr.first_approval_at))
      .filter((h): h is number => h !== undefined)
      .sort((a, b) => a - b);

    return {
      merged: merged.length,
      approved: merged.filter(pr => Number(pr.approval_count) > 0).length,
      open: Number((openRow as any)?.n ?? 0),
      medianMergeHours: median(mergeHours),
      medianReviewHours: median(reviewHours),
    };
  }
}
