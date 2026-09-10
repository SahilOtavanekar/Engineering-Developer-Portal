import type { DatabaseService } from '@backstage/backend-plugin-api';
import type { BitbucketPullRequest } from '../bitbucket/types';

type DatabaseClient = Awaited<ReturnType<DatabaseService['getClient']>>;

export interface ReviewSummary {
  /** Merged pull requests inside the window. */
  merged: number;
  /** Of those, how many had at least one approval. */
  approved: number;
  /**
   * Of those, how many were approved by somebody **other than the author**.
   *
   * The distinction is not academic on this estate: measured 2026-09-09 over
   * 365 merged pull requests in 90 days, **265 carried an approval and only 85
   * carried one from anybody but the author**. So `approved` counts the button
   * being pressed and this counts a second person having looked -- which is
   * what section 4 of the specification means by peer review, and what explains
   * the 12-second median time to first approval recorded in CLAUDE.md.
   *
   * A participant whose account id is unknown, or a pull request whose author
   * is, cannot be shown to be a different person and so does not count. That is
   * conservative by design -- an approval the portal cannot attribute is not
   * evidence of review -- and costs nothing today: no row in either column is
   * null.
   */
  peerApproved: number;
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

/** One merged pull request awaiting a diffstat. */
export interface PendingSize {
  id: number;
  prId: number;
  repositoryId: number;
  slug: string;
  workspace: string;
}

/** What one pull request's diffstat came back as. */
export interface RecordedSize {
  id: number;
  filesChanged: number;
  filesAdded: number;
  linesAdded: number;
  linesRemoved: number;
  excludedLines: number;
}

export interface SizeSummary {
  /** Merged pull requests in the window whose diffstat has been fetched. */
  measured: number;
  /** Merged pull requests in the window still awaiting one. */
  pending: number;
  /**
   * Mean changed lines across the measured ones -- the statistic the
   * specification bands. Undefined when nothing is measured.
   */
  averageChangedLines?: number;
  /**
   * Median changed lines.
   *
   * Stored and served although nothing scores it, because on this estate the
   * two disagree violently: the largest pull request is a 31,856-line initial
   * import, and one of those drags a mean past 1,000 however disciplined every
   * later change was. Having both means switching statistic is a decision
   * rather than a 389-request refetch.
   */
  medianChangedLines?: number;
  /** Largest single pull request in the window, for the detail line. */
  largestChangedLines?: number;
  /**
   * Of the measured ones, how many were almost entirely new files.
   *
   * An import, not a change anybody could have made smaller. Reported so the
   * card can say when a bad score is a repository's birth rather than its
   * habits.
   */
  imports: number;
}

/**
 * A pull request at least this proportion of whose files are new is an import.
 *
 * 0.9 rather than 1.0: `dai-delivery#1` added 157 of 158 files and
 * `daarwyn-bo-ui#1` 40 of 41, both of which are plainly imports, and requiring
 * every single file to be new would miss both for the sake of one touched
 * `.gitignore`.
 */
const IMPORT_ADDED_SHARE = 0.9;

/** Below this, "almost entirely new files" says nothing useful. */
const IMPORT_MINIMUM_FILES = 5;

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

  /**
   * Merged pull requests with no diffstat yet, newest first.
   *
   * Newest first so that a budgeted sweep measures the window the score
   * actually reads before it works back through history nothing scores. The
   * first pass on this estate has about 389 to get through.
   */
  async pendingSizes(workspace: string, limit: number): Promise<PendingSize[]> {
    if (limit <= 0) return [];

    const rows = (await this.db('pull_request as pr')
      .join('repository as r', 'r.id', 'pr.repository_id')
      .where({
        'r.workspace': workspace,
        'pr.state': 'MERGED',
        'r.is_live': true,
      })
      .whereNull('pr.lines_added')
      .orderBy('pr.updated_at', 'desc')
      .limit(limit)
      .select(
        'pr.id as id',
        'pr.pr_id as prId',
        'pr.repository_id as repositoryId',
        'r.slug as slug',
        'r.workspace as workspace',
      )) as Array<{
      id: number;
      prId: number;
      repositoryId: number;
      slug: string;
      workspace: string;
    }>;

    return rows.map(row => ({
      id: Number(row.id),
      prId: Number(row.prId),
      repositoryId: Number(row.repositoryId),
      slug: row.slug,
      workspace: row.workspace,
    }));
  }

  /** How many merged pull requests are still waiting, for the pass to report. */
  async pendingSizeCount(workspace: string): Promise<number> {
    const row = await this.db('pull_request as pr')
      .join('repository as r', 'r.id', 'pr.repository_id')
      .where({
        'r.workspace': workspace,
        'pr.state': 'MERGED',
        'r.is_live': true,
      })
      .whereNull('pr.lines_added')
      .count({ n: '*' })
      .first();
    return Number((row as any)?.n ?? 0);
  }

  /**
   * Writes measured sizes back.
   *
   * One statement per pull request rather than a bulk upsert: the rows already
   * exist and only these five columns change, so an upsert would have to
   * restate every immutable field and risk overwriting one.
   */
  async recordSizes(sizes: RecordedSize[]): Promise<number> {
    let written = 0;
    for (const size of sizes) {
      written += await this.db('pull_request').where({ id: size.id }).update({
        files_changed: size.filesChanged,
        files_added: size.filesAdded,
        lines_added: size.linesAdded,
        lines_removed: size.linesRemoved,
        excluded_lines: size.excludedLines,
      });
    }
    return written;
  }

  /**
   * Pull request size over the window, for the metric section 5 requires.
   *
   * `pending` is reported beside `measured` because the two absences mean
   * different things: a repository with nothing measured yet must score as
   * unmeasurable, not as small.
   */
  async sizeSummary(repositoryId: number, since: Date): Promise<SizeSummary> {
    const rows = (await this.db('pull_request')
      .where({ repository_id: repositoryId, state: 'MERGED' })
      .where('updated_at', '>=', since)
      .select(
        'lines_added',
        'lines_removed',
        'files_changed',
        'files_added',
      )) as Array<{
      lines_added: number | null;
      lines_removed: number | null;
      files_changed: number | null;
      files_added: number | null;
    }>;

    const measured = rows.filter(row => row.lines_added !== null);
    const changed = measured
      .map(row => Number(row.lines_added ?? 0) + Number(row.lines_removed ?? 0))
      .sort((a, b) => a - b);

    const imports = measured.filter(row => {
      const files = Number(row.files_changed ?? 0);
      const added = Number(row.files_added ?? 0);
      return (
        files >= IMPORT_MINIMUM_FILES && added / files >= IMPORT_ADDED_SHARE
      );
    }).length;

    return {
      measured: measured.length,
      pending: rows.length - measured.length,
      averageChangedLines:
        changed.length === 0
          ? undefined
          : Math.round(changed.reduce((a, b) => a + b, 0) / changed.length),
      medianChangedLines: median(changed),
      largestChangedLines:
        changed.length === 0 ? undefined : changed[changed.length - 1],
      imports,
    };
  }

  async reviewSummary(
    repositoryId: number,
    since: Date,
  ): Promise<ReviewSummary> {
    const merged = (await this.db('pull_request')
      .where({ repository_id: repositoryId, state: 'MERGED' })
      .where('updated_at', '>=', since)
      .select(
        'id',
        'author_account_id',
        'approval_count',
        'created_at',
        'updated_at',
        'closed_at',
        'first_approval_at',
      )) as Array<{
      id: number;
      author_account_id: string | null;
      approval_count: number;
      created_at: Date;
      updated_at: Date;
      closed_at: Date | null;
      first_approval_at: Date | null;
    }>;

    // Who approved each of those, so a self-approval can be told from a review.
    //
    // A second query rather than a join: joining would return a row per
    // approver and the deduplication would happen in JavaScript anyway. A
    // correlated subquery would do it in one, but `is distinct from` is
    // Postgres-only and the unit suite runs on SQLite.
    //
    // Chunked for the same reason inserts are: SQLite caps bound parameters per
    // statement, and a busy repository can carry more merged pull requests in
    // the window than that cap allows.
    const peerApprovers = new Set<number>();
    const authorOf = new Map(merged.map(pr => [pr.id, pr.author_account_id]));
    for (let i = 0; i < merged.length; i += CHUNK) {
      const ids = merged.slice(i, i + CHUNK).map(pr => pr.id);
      const rows = (await this.db('pull_request_participant')
        .whereIn('pull_request_id', ids)
        .where({ approved: true })
        .select('pull_request_id', 'account_id')) as Array<{
        pull_request_id: number;
        account_id: string | null;
      }>;

      for (const row of rows) {
        const author = authorOf.get(row.pull_request_id);
        if (row.account_id && author && row.account_id !== author) {
          peerApprovers.add(row.pull_request_id);
        }
      }
    }

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
      peerApproved: peerApprovers.size,
      open: Number((openRow as any)?.n ?? 0),
      medianMergeHours: median(mergeHours),
      medianReviewHours: median(reviewHours),
    };
  }
}
