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
  /** Mean hours from opening to merge. Undefined when nothing merged. */
  medianMergeHours?: number;
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
      source_branch: pr.sourceBranch ?? null,
      destination_branch: pr.destinationBranch ?? null,
    }));

    for (let i = 0; i < rows.length; i += CHUNK) {
      await this.db('pull_request')
        .insert(rows.slice(i, i + CHUNK))
        .onConflict(['repository_id', 'pr_id'])
        // State, approvals and comments all move while a PR is open.
        .merge([
          'title',
          'state',
          'updated_at',
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
      .select('approval_count', 'created_at', 'updated_at')) as Array<{
      approval_count: number;
      created_at: Date;
      updated_at: Date;
    }>;

    const openRow = await this.db('pull_request')
      .where({ repository_id: repositoryId, state: 'OPEN' })
      .count({ n: '*' })
      .first();

    const hours = merged
      .map(
        pr =>
          (new Date(pr.updated_at).getTime() -
            new Date(pr.created_at).getTime()) /
          3_600_000,
      )
      .filter(h => h >= 0)
      .sort((a, b) => a - b);

    return {
      merged: merged.length,
      approved: merged.filter(pr => Number(pr.approval_count) > 0).length,
      open: Number((openRow as any)?.n ?? 0),
      medianMergeHours:
        hours.length === 0
          ? undefined
          : Math.round(hours[Math.floor(hours.length / 2)] * 10) / 10,
    };
  }
}
