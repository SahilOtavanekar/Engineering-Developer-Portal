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
  /**
   * Parent hashes, first parent first.
   *
   * Already fetched -- `values.parents.hash` has always been in the requested
   * fields -- and previously reduced to `parentCount` and discarded. The
   * first-parent chain is the only way to tell a commit made on the default
   * branch from one a merge brought in from a feature branch.
   */
  parents?: string[];
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
  /**
   * When the pull request was merged or declined.
   *
   * The real end of its life, unlike `updatedAt`, which moves on any later
   * edit -- a comment, a title change -- and so overstates how long a merge
   * took. Verified populated on every merged pull request sampled.
   */
  closedAt?: string;
  /**
   * When the first reviewer approved.
   *
   * Absent when nobody approved. Measured from Bitbucket's
   * `participants.participated_on`, which was present on all 122 of the 177
   * sampled merged pull requests that carried an approval.
   */
  firstApprovalAt?: string;
  commentCount: number;
  approvalCount: number;
  participantCount: number;
  authorAccountId?: string;
  authorName?: string;
  sourceBranch?: string;
  destinationBranch?: string;
  /**
   * The commit this pull request produced on its destination branch.
   *
   * **Abbreviated to 12 characters by Bitbucket**, where commit hashes are full
   * 40-character SHAs. Any join against commits must be on a prefix; matching
   * whole strings silently finds nothing and makes every commit look direct.
   * Verified populated on 10 of 10 merged pull requests sampled.
   */
  mergeCommitHash?: string;
}

/**
 * One person's explicit permission on a repository.
 *
 * Bitbucket's own answer to "who is accountable for this", and a far better
 * one than commit counts: measured across the estate, the busiest committer
 * and the admin disagree in 18 of the 26 repositories where both are known.
 *
 * Carries no email. `GET /2.0/users/{account_id}` would supply one but returns
 * 403 without the `read:user` scope, so identity has to be joined on the
 * display name until Entra ID supplies a directory.
 */
export interface BitbucketRepositoryPermission {
  /** `admin`, `write` or `read`. */
  permission: string;
  displayName?: string;
  /** Stable across renames, unlike the display name. */
  accountId?: string;
  uuid?: string;
  nickname?: string;
}

export interface ListPullRequestsOptions {
  /** Stop paging once PRs updated before this are reached. */
  since?: Date;
  /** Bitbucket PR states. Defaults to MERGED and OPEN. */
  states?: string[];
  maxPages?: number;
}

/**
 * One deployment of a release to an environment.
 *
 * `environmentType` is Bitbucket's normalised bucket -- Test, Staging or
 * Production -- and is what to group by. `environmentName` is whatever the
 * team called it, and varies in case and wording across the estate.
 */
export interface BitbucketDeployment {
  uuid: string;
  number?: number;
  environmentName: string;
  environmentType?: string;
  state: string;
  releaseName?: string;
  commitHash?: string;
  createdAt: string;
  lastUpdatedAt?: string;
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

  /**
   * Recent deployments, newest first.
   *
   * Empty for a repository whose pipeline declares no deployment step, or
   * whose declared environment name does not match a configured one.
   */
  listDeployments(
    workspace: string,
    slug: string,
    options?: { limit?: number },
  ): Promise<BitbucketDeployment[]>;

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
   * Who has explicit permission on a repository, and at what level.
   *
   * One request per repository -- the workspace-wide equivalent
   * (`/2.0/workspaces/{ws}/permissions/repositories`) would answer for the
   * whole estate at once but returns 403 for this credential.
   */
  listRepositoryPermissions(
    workspace: string,
    slug: string,
  ): Promise<BitbucketRepositoryPermission[]>;

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
