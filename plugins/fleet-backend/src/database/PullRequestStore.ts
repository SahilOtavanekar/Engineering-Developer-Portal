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
      merge_commit_hash: pr.mergeCommitHash ?? null,
      closed_by_account_id: pr.closedByAccountId ?? null,
      closed_by_name: pr.closedByName ?? null,
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
          // Only exists once the pull request merges, so a PR first seen open
          // would never acquire it otherwise.
          'merge_commit_hash',
          'closed_by_account_id',
          'closed_by_name',
        ]);
    }
    await this.replaceParticipants(repositoryId, pullRequests);
    return rows.length;
  }

  /**
   * Replaces the participant rows for the given pull requests.
   *
   * Snapshot-replaced rather than appended: a reviewer can withdraw an approval
   * or be removed, so yesterday's row is not history worth keeping -- unlike a
   * commit or a score, which are.
   *
   * Only touches pull requests the caller actually fetched. A pull request
   * whose participants were not returned keeps whatever it had, because an
   * empty list from a request that did not ask for participants is
   * indistinguishable from a pull request nobody looked at.
   */
  private async replaceParticipants(
    repositoryId: number,
    pullRequests: BitbucketPullRequest[],
  ): Promise<void> {
    const withParticipants = pullRequests.filter(
      pr => pr.participants !== undefined,
    );
    if (withParticipants.length === 0) return;

    const ids = (await this.db('pull_request')
      .where({ repository_id: repositoryId })
      .whereIn(
        'pr_id',
        withParticipants.map(pr => pr.id),
      )
      .select('id', 'pr_id')) as Array<{ id: number; pr_id: number }>;
    const byPrId = new Map(ids.map(row => [Number(row.pr_id), Number(row.id)]));

    const rowIds = [...byPrId.values()];
    for (let i = 0; i < rowIds.length; i += CHUNK) {
      await this.db('pull_request_participant')
        .whereIn('pull_request_id', rowIds.slice(i, i + CHUNK))
        .delete();
    }

    const rows: Array<Record<string, unknown>> = [];
    for (const pr of withParticipants) {
      const pullRequestId = byPrId.get(pr.id);
      if (pullRequestId === undefined) continue;
      // Deduplicate on account id: Bitbucket has been seen to repeat a
      // participant, and the unique constraint would reject the whole chunk.
      const seen = new Set<string>();
      for (const participant of pr.participants ?? []) {
        const key = participant.accountId ?? `name:${participant.displayName}`;
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push({
          pull_request_id: pullRequestId,
          account_id: participant.accountId ?? null,
          display_name: participant.displayName ?? null,
          role: participant.role,
          approved: participant.approved,
          participated_at: participant.participatedAt
            ? new Date(participant.participatedAt)
            : null,
        });
      }
    }

    for (let i = 0; i < rows.length; i += CHUNK) {
      await this.db('pull_request_participant').insert(
        rows.slice(i, i + CHUNK),
      );
    }
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

  /**
   * `merge_commit_hash` of pull requests merged into one branch.
   *
   * Scoped to the branch on purpose: a pull request merged into `develop` does
   * not license a commit landing on `main`. Measured on this estate the two
   * readings happen to agree everywhere, but 13 repositories send their pull
   * requests to `develop`, so the looser rule would start being wrong the
   * moment one of them merged develop into main through a pull request.
   */
  /**
   * How many pull requests merged into a branch, and how many carry the merge
   * commit hash the classifier needs.
   *
   * The classifier must refuse to run when these disagree. `merge_commit_hash`
   * arrives only with a pull request the ingestion watermark actually
   * re-fetched, so a repository can hold 55 merged pull requests and no hashes
   * at all -- and classifying against an empty hash list does not fail, it
   * confidently reports every commit as direct. That happened on this estate:
   * a first pass classified 1,031 commits direct and **zero** via pull request.
   */
  async mergeHashCoverage(
    repositoryId: number,
    branch: string,
  ): Promise<{ merged: number; withHash: number }> {
    const [row] = (await this.db('pull_request')
      .where({ repository_id: repositoryId, state: 'MERGED' })
      .where({ destination_branch: branch })
      .count({ merged: '*' })
      .count({ withHash: 'merge_commit_hash' })) as Array<{
      merged: string | number;
      withHash: string | number;
    }>;

    return {
      merged: Number(row?.merged ?? 0),
      withHash: Number(row?.withHash ?? 0),
    };
  }

  async mergeHashesForBranch(
    repositoryId: number,
    branch: string,
  ): Promise<string[]> {
    return this.db('pull_request')
      .where({ repository_id: repositoryId, state: 'MERGED' })
      .where({ destination_branch: branch })
      .whereNotNull('merge_commit_hash')
      .pluck('merge_commit_hash');
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
