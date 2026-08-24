/**
 * A repository, described in the terms the portal cares about rather than the
 * terms Bitbucket returns. Adapters map onto this type, so nothing downstream
 * is coupled to Bitbucket payload shapes.
 *
 * The field set is driven by the repository metadata listed in section 2 of the
 * requirements document.
 */
export interface BitbucketRepository {
  workspace: string;
  slug: string;
  name: string;
  description?: string;
  /** Browser URL, for linking out of the catalog. */
  url: string;
  /** Bitbucket project the repo belongs to, e.g. 'PORTAL'. */
  projectKey?: string;
  defaultBranch?: string;
  isPrivate: boolean;
  /** Absent when Bitbucket has not detected one, which is common. */
  language?: string;
  sizeBytes?: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * A single commit, in the terms the portal cares about.
 *
 * Merge commits are kept but flagged via `parentCount`, so activity metrics can
 * exclude them rather than counting one merge as real authorship.
 */
export interface BitbucketCommit {
  hash: string;
  committedAt: string;
  message?: string;
  /** Raw git author string, e.g. 'Jo Bloggs <jo@example.com>'. */
  authorRaw?: string;
  authorName?: string;
  /** Lowercased. The only identifier most commits carry. */
  authorEmail?: string;
  /** Present only when Bitbucket matched the email to an account. */
  authorAccountId?: string;
  parentCount: number;
}

/** A branch and how recently it was touched. */
export interface BitbucketBranch {
  name: string;
  lastCommitAt?: string;
  lastCommitHash?: string;
}

/**
 * One pipeline run.
 *
 * `state` and `result` are separate because an in-progress run has no result
 * yet, and treating that absence as a failure would misreport every repository
 * that happens to be building when the sync runs.
 */
export interface BitbucketPipelineRun {
  uuid: string;
  buildNumber?: number;
  state: string;
  result?: string;
  refName?: string;
  createdAt: string;
  durationSeconds?: number;
}

/**
 * One pull request.
 *
 * `approvalCount` counts reviewers who actually approved, which is the signal
 * "code review completed" needs -- assigning a reviewer who never responds is
 * not a review.
 */
export interface BitbucketPullRequest {
  id: number;
  title?: string;
  state: string;
  createdAt: string;
  updatedAt: string;
  commentCount: number;
  approvalCount: number;
  participantCount: number;
  authorAccountId?: string;
  authorName?: string;
  sourceBranch?: string;
  destinationBranch?: string;
}

export interface ListPullRequestsOptions {
  /** Stop paging once PRs updated before this are reached. */
  since?: Date;
  /** Bitbucket PR states. Defaults to MERGED and OPEN. */
  states?: string[];
  maxPages?: number;
}

export interface ListCommitsOptions {
  /**
   * Stop paging once commits older than this are reached. Bitbucket has no
   * server-side date filter on this endpoint, so the cutoff is applied while
   * walking pages in reverse-chronological order.
   */
  since?: Date;
  /** Defaults to the repository's main branch. */
  branch?: string;
  /** Hard ceiling on pages fetched, so one busy repository cannot run away. */
  maxPages?: number;
}

/**
 * Everything the portal needs from Bitbucket.
 *
 * Implemented by {@link BitbucketCloudClient} against the real API and by
 * FakeBitbucketClient for tests. Consumers depend on this interface only.
 */
export interface BitbucketClient {
  /**
   * Every repository in the workspace. Pagination is handled internally.
   *
   * Workspace slugs cannot be discovered from the API -- the endpoints that
   * enumerated them were removed in Atlassian CHANGE-2770 -- so callers must
   * supply the slug from configuration.
   */
  listRepositories(workspace: string): Promise<BitbucketRepository[]>;

  /**
   * Commits on a branch, newest first, bounded by `options`.
   *
   * Returns an empty list for a repository with no commits at all, which
   * Bitbucket reports as a 404 rather than an empty page.
   */
  listCommits(
    workspace: string,
    slug: string,
    options?: ListCommitsOptions,
  ): Promise<BitbucketCommit[]>;

  /** Every branch in the repository, with its most recent commit. */
  listBranches(workspace: string, slug: string): Promise<BitbucketBranch[]>;

  /** Recent pipeline runs, newest first. */
  listPipelineRuns(
    workspace: string,
    slug: string,
    options?: { limit?: number },
  ): Promise<BitbucketPipelineRun[]>;

  /** Pull requests, newest-updated first, bounded by `options`. */
  listPullRequests(
    workspace: string,
    slug: string,
    options?: ListPullRequestsOptions,
  ): Promise<BitbucketPullRequest[]>;

  /**
   * One file's contents, or undefined when it does not exist.
   *
   * Absence is an ordinary answer here -- most repositories lack most
   * manifests -- so it is not an error.
   */
  getFileContent(
    workspace: string,
    slug: string,
    path: string,
    branch?: string,
  ): Promise<string | undefined>;

  /** Paths at the repository root. Empty for a repository with no commits. */
  listRootFiles(
    workspace: string,
    slug: string,
    branch?: string,
  ): Promise<string[]>;

  /**
   * Requests issued since construction. Bitbucket Cloud returns no
   * `X-RateLimit-*` headers, so quota consumption can only be tracked by
   * counting on our side.
   */
  readonly requestCount: number;
}
