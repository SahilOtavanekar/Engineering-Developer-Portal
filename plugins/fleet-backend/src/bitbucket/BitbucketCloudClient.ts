import type { LoggerService } from '@backstage/backend-plugin-api';
import type { BitbucketCloudIntegrationConfig } from '@backstage/integration';
import { BitbucketApiError } from './errors';
import type {
  BitbucketBranch,
  BitbucketClient,
  BitbucketCommit,
  BitbucketDeployment,
  BitbucketPipelineRun,
  BitbucketPullRequest,
  BitbucketRepository,
  ListCommitsOptions,
  ListPullRequestsOptions,
} from './types';

const DEFAULT_API_BASE_URL = 'https://api.bitbucket.org/2.0';

/** Bitbucket's maximum. Fewer pages means fewer requests. */
const PAGE_SIZE = 100;

/**
 * Partial-response projection. Bitbucket returns a great deal more than this
 * per repository; asking only for what we map keeps payloads small.
 */
const REPOSITORY_FIELDS = [
  'next',
  'values.slug',
  'values.name',
  'values.description',
  'values.links.html.href',
  'values.project.key',
  'values.mainbranch.name',
  'values.is_private',
  'values.language',
  'values.size',
  'values.created_on',
  'values.updated_on',
].join(',');

const COMMIT_FIELDS = [
  'next',
  'values.hash',
  'values.date',
  'values.message',
  'values.author.raw',
  'values.author.user.account_id',
  'values.parents.hash',
].join(',');

/** Pages fetched per repository unless a caller says otherwise. */
const DEFAULT_MAX_COMMIT_PAGES = 20;

const BRANCH_FIELDS = [
  'next',
  'values.name',
  'values.target.date',
  'values.target.hash',
].join(',');

const PIPELINE_FIELDS = [
  'next',
  'values.uuid',
  'values.build_number',
  'values.state.name',
  'values.state.result.name',
  'values.target.ref_name',
  'values.created_on',
  'values.duration_in_seconds',
].join(',');

/** Enough runs to judge a success rate without paging a busy repository. */
const DEFAULT_PIPELINE_LIMIT = 20;

const DEPLOYMENT_FIELDS = [
  'values.uuid',
  'values.number',
  'values.environment.name',
  'values.environment.environment_type.name',
  'values.state.name',
  'values.release.name',
  'values.release.commit.hash',
  'values.created_on',
  'values.last_update_time',
].join(',');

/**
 * Deployments kept per repository. Enough to cover every environment several
 * times over, without paging a repository that deploys constantly.
 */
const DEFAULT_DEPLOYMENT_LIMIT = 50;

const PULL_REQUEST_FIELDS = [
  'next',
  'values.id',
  'values.title',
  'values.state',
  'values.created_on',
  'values.updated_on',
  'values.comment_count',
  'values.author.display_name',
  'values.author.account_id',
  'values.participants.approved',
  'values.participants.role',
  'values.source.branch.name',
  'values.destination.branch.name',
].join(',');

/**
 * The pull requests endpoint rejects pagelen above 50 with 'Invalid pagelen',
 * unlike repositories, commits and branches which accept 100. Verified against
 * the live API.
 */
const PR_PAGE_SIZE = 50;

const DEFAULT_PR_STATES = ['MERGED', 'OPEN'];
const DEFAULT_MAX_PR_PAGES = 10;

export type BitbucketCredentials =
  | { username: string; appPassword: string }
  | { token: string };

export interface BitbucketCloudClientOptions {
  credentials: BitbucketCredentials;
  apiBaseUrl?: string;
  logger?: LoggerService;
  /** Injected by tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

/** Shape of a Bitbucket paginated response, narrowed to what we read. */
interface PagedResponse {
  values?: unknown[];
  next?: string;
}

function authorizationHeader(credentials: BitbucketCredentials): string {
  if ('token' in credentials) {
    return `Bearer ${credentials.token}`;
  }
  const basic = Buffer.from(
    `${credentials.username}:${credentials.appPassword}`,
  ).toString('base64');
  return `Basic ${basic}`;
}

/** Bitbucket uses empty strings where it means "not set". */
function optional(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function toRepository(workspace: string, raw: any): BitbucketRepository {
  return {
    workspace,
    slug: raw.slug,
    name: optional(raw.name) ?? raw.slug,
    description: optional(raw.description),
    url:
      optional(raw.links?.html?.href) ??
      `https://bitbucket.org/${workspace}/${raw.slug}`,
    projectKey: optional(raw.project?.key),
    defaultBranch: optional(raw.mainbranch?.name),
    isPrivate: Boolean(raw.is_private),
    language: optional(raw.language),
    sizeBytes: typeof raw.size === 'number' ? raw.size : undefined,
    createdAt: raw.created_on,
    updatedAt: raw.updated_on,
  };
}

/** Splits a git author string such as 'Jo Bloggs <jo@example.com>'. */
export function parseCommitAuthor(raw: string | undefined): {
  name?: string;
  email?: string;
} {
  if (!raw) return {};
  const match = /^(.*?)\s*<([^>]*)>\s*$/.exec(raw);
  if (!match) return { name: raw.trim() || undefined };
  return {
    name: match[1].trim() || undefined,
    email: match[2].trim().toLowerCase() || undefined,
  };
}

function toCommit(raw: any): BitbucketCommit {
  const { name, email } = parseCommitAuthor(raw.author?.raw);
  return {
    hash: raw.hash,
    committedAt: raw.date,
    message: optional(raw.message),
    authorRaw: optional(raw.author?.raw),
    authorName: name,
    authorEmail: email,
    authorAccountId: optional(raw.author?.user?.account_id),
    parentCount: Array.isArray(raw.parents) ? raw.parents.length : 1,
  };
}

/**
 * Bitbucket Cloud implementation of {@link BitbucketClient}.
 *
 * Deliberately thin: it fetches, paginates, and maps onto domain types. Retry,
 * backoff and scheduling belong to the ingestion layer above it.
 */
export class BitbucketCloudClient implements BitbucketClient {
  private readonly authorization: string;
  private readonly apiBaseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly logger?: LoggerService;
  private requests = 0;

  constructor(options: BitbucketCloudClientOptions) {
    this.authorization = authorizationHeader(options.credentials);
    this.apiBaseUrl = (options.apiBaseUrl ?? DEFAULT_API_BASE_URL).replace(
      /\/+$/,
      '',
    );
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.logger = options.logger;
  }

  /**
   * Builds a client from the `integrations.bitbucketCloud` entry that
   * Backstage has already parsed, so credentials live in exactly one place.
   */
  static fromIntegration(
    integration: BitbucketCloudIntegrationConfig,
    options: Omit<
      BitbucketCloudClientOptions,
      'credentials' | 'apiBaseUrl'
    > = {},
  ): BitbucketCloudClient {
    const { username, appPassword, token } = integration;

    let credentials: BitbucketCredentials;
    if (token) {
      credentials = { token };
    } else if (username && appPassword) {
      credentials = { username, appPassword };
    } else {
      throw new Error(
        `Bitbucket Cloud integration for '${integration.host}' has no usable credentials: ` +
          `set either 'token', or both 'username' and 'appPassword'`,
      );
    }

    return new BitbucketCloudClient({
      ...options,
      credentials,
      apiBaseUrl: integration.apiBaseUrl,
    });
  }

  get requestCount(): number {
    return this.requests;
  }

  async listRepositories(workspace: string): Promise<BitbucketRepository[]> {
    if (!workspace) {
      throw new Error('a workspace slug is required');
    }

    const repositories: BitbucketRepository[] = [];
    let url: string | undefined =
      `${this.apiBaseUrl}/repositories/${encodeURIComponent(workspace)}` +
      `?pagelen=${PAGE_SIZE}&sort=-updated_on&fields=${REPOSITORY_FIELDS}`;

    while (url) {
      const page: PagedResponse = await this.request(url);
      for (const raw of page.values ?? []) {
        repositories.push(toRepository(workspace, raw));
      }
      url = page.next;
    }

    this.logger?.debug(
      `Listed ${repositories.length} repositories in '${workspace}' using ${this.requests} requests`,
    );
    return repositories;
  }

  async listCommits(
    workspace: string,
    slug: string,
    options: ListCommitsOptions = {},
  ): Promise<BitbucketCommit[]> {
    if (!workspace || !slug) {
      throw new Error('a workspace slug and repository slug are required');
    }

    const maxPages = options.maxPages ?? DEFAULT_MAX_COMMIT_PAGES;
    const cutoff = options.since?.getTime();
    const path = options.branch
      ? `/commits/${encodeURIComponent(options.branch)}`
      : '/commits';

    const commits: BitbucketCommit[] = [];
    let url: string | undefined =
      `${this.apiBaseUrl}/repositories/${encodeURIComponent(workspace)}/` +
      `${encodeURIComponent(
        slug,
      )}${path}?pagelen=${PAGE_SIZE}&fields=${COMMIT_FIELDS}`;

    for (let page = 0; url && page < maxPages; page++) {
      let response: PagedResponse;
      try {
        response = await this.request(url);
      } catch (error) {
        // An empty repository, or a branch that does not exist, is a 404 here.
        // That is an absence of commits, not a failure worth propagating.
        if (error instanceof BitbucketApiError && error.status === 404) {
          return commits;
        }
        throw error;
      }

      let reachedCutoff = false;
      for (const raw of response.values ?? []) {
        const commit = toCommit(raw);
        if (
          cutoff !== undefined &&
          new Date(commit.committedAt).getTime() <= cutoff
        ) {
          reachedCutoff = true;
          break;
        }
        commits.push(commit);
      }

      if (reachedCutoff) break;
      url = response.next;
    }

    return commits;
  }

  async listBranches(
    workspace: string,
    slug: string,
  ): Promise<BitbucketBranch[]> {
    if (!workspace || !slug) {
      throw new Error('a workspace slug and repository slug are required');
    }

    const branches: BitbucketBranch[] = [];
    let url: string | undefined =
      `${this.apiBaseUrl}/repositories/${encodeURIComponent(workspace)}/` +
      `${encodeURIComponent(
        slug,
      )}/refs/branches?pagelen=${PAGE_SIZE}&fields=${BRANCH_FIELDS}`;

    while (url) {
      let page: PagedResponse;
      try {
        page = await this.request(url);
      } catch (error) {
        // A repository with no commits has no branches, and Bitbucket says so
        // with a 404 rather than an empty page.
        if (error instanceof BitbucketApiError && error.status === 404) {
          return branches;
        }
        throw error;
      }

      for (const raw of (page.values ?? []) as any[]) {
        branches.push({
          name: raw.name,
          lastCommitAt: optional(raw.target?.date),
          lastCommitHash: optional(raw.target?.hash),
        });
      }
      url = page.next;
    }
    return branches;
  }

  async listDeployments(
    workspace: string,
    slug: string,
    options: { limit?: number } = {},
  ): Promise<BitbucketDeployment[]> {
    if (!workspace || !slug) {
      throw new Error('a workspace slug and repository slug are required');
    }

    const limit = Math.max(1, options.limit ?? DEFAULT_DEPLOYMENT_LIMIT);
    const url =
      `${this.apiBaseUrl}/repositories/${encodeURIComponent(workspace)}/` +
      `${encodeURIComponent(slug)}/deployments/?pagelen=${Math.min(
        limit,
        PAGE_SIZE,
      )}` +
      `&fields=${DEPLOYMENT_FIELDS}`;

    let page: PagedResponse;
    try {
      page = await this.request(url);
    } catch (error) {
      // Deployments were never enabled on this repository.
      if (error instanceof BitbucketApiError && error.status === 404) {
        return [];
      }
      throw error;
    }

    const deployments = ((page.values ?? []) as any[]).map(raw => ({
      uuid: raw.uuid,
      number: typeof raw.number === 'number' ? raw.number : undefined,
      environmentName: optional(raw.environment?.name) ?? 'unknown',
      environmentType: optional(raw.environment?.environment_type?.name),
      state: optional(raw.state?.name) ?? 'UNKNOWN',
      releaseName: optional(raw.release?.name),
      commitHash: optional(raw.release?.commit?.hash),
      createdAt: raw.created_on,
      lastUpdatedAt: optional(raw.last_update_time),
    }));

    // Bitbucket does not guarantee an order here, and "what is live" depends
    // entirely on which record is newest.
    deployments.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
    return deployments.slice(0, limit);
  }

  async listPipelineRuns(
    workspace: string,
    slug: string,
    options: { limit?: number } = {},
  ): Promise<BitbucketPipelineRun[]> {
    if (!workspace || !slug) {
      throw new Error('a workspace slug and repository slug are required');
    }

    const limit = Math.max(1, options.limit ?? DEFAULT_PIPELINE_LIMIT);
    const url =
      `${this.apiBaseUrl}/repositories/${encodeURIComponent(workspace)}/` +
      `${encodeURIComponent(slug)}/pipelines/?pagelen=${Math.min(
        limit,
        PAGE_SIZE,
      )}` +
      `&sort=-created_on&fields=${PIPELINE_FIELDS}`;

    let page: PagedResponse;
    try {
      page = await this.request(url);
    } catch (error) {
      // Pipelines have never been enabled on this repository.
      if (error instanceof BitbucketApiError && error.status === 404) {
        return [];
      }
      throw error;
    }

    return ((page.values ?? []) as any[]).slice(0, limit).map(raw => ({
      uuid: raw.uuid,
      buildNumber:
        typeof raw.build_number === 'number' ? raw.build_number : undefined,
      state: optional(raw.state?.name) ?? 'UNKNOWN',
      result: optional(raw.state?.result?.name),
      refName: optional(raw.target?.ref_name),
      createdAt: raw.created_on,
      durationSeconds:
        typeof raw.duration_in_seconds === 'number'
          ? raw.duration_in_seconds
          : undefined,
    }));
  }

  async listPullRequests(
    workspace: string,
    slug: string,
    options: ListPullRequestsOptions = {},
  ): Promise<BitbucketPullRequest[]> {
    if (!workspace || !slug) {
      throw new Error('a workspace slug and repository slug are required');
    }

    const maxPages = options.maxPages ?? DEFAULT_MAX_PR_PAGES;
    const cutoff = options.since?.getTime();
    const states = options.states ?? DEFAULT_PR_STATES;
    const stateQuery = states
      .map(s => `state=${encodeURIComponent(s)}`)
      .join('&');

    const pullRequests: BitbucketPullRequest[] = [];
    let url: string | undefined =
      `${this.apiBaseUrl}/repositories/${encodeURIComponent(workspace)}/` +
      `${encodeURIComponent(slug)}/pullrequests?${stateQuery}` +
      `&pagelen=${PR_PAGE_SIZE}&sort=-updated_on&fields=${PULL_REQUEST_FIELDS}`;

    for (let page = 0; url && page < maxPages; page++) {
      let response: PagedResponse;
      try {
        response = await this.request(url);
      } catch (error) {
        // A repository that has never had a pull request answers 404.
        if (error instanceof BitbucketApiError && error.status === 404) {
          return pullRequests;
        }
        throw error;
      }

      let reachedCutoff = false;
      for (const raw of (response.values ?? []) as any[]) {
        const updatedAt = raw.updated_on;
        if (cutoff !== undefined && new Date(updatedAt).getTime() <= cutoff) {
          reachedCutoff = true;
          break;
        }

        const participants = Array.isArray(raw.participants)
          ? raw.participants
          : [];
        pullRequests.push({
          id: raw.id,
          title: optional(raw.title),
          state: raw.state,
          createdAt: raw.created_on,
          updatedAt,
          commentCount:
            typeof raw.comment_count === 'number' ? raw.comment_count : 0,
          approvalCount: participants.filter((p: any) => p.approved).length,
          participantCount: participants.length,
          authorAccountId: optional(raw.author?.account_id),
          authorName: optional(raw.author?.display_name),
          sourceBranch: optional(raw.source?.branch?.name),
          destinationBranch: optional(raw.destination?.branch?.name),
        });
      }

      if (reachedCutoff) break;
      url = response.next;
    }

    return pullRequests;
  }

  async getFileContent(
    workspace: string,
    slug: string,
    path: string,
    branch?: string,
  ): Promise<string | undefined> {
    if (!workspace || !slug || !path) {
      throw new Error(
        'a workspace slug, repository slug and file path are required',
      );
    }

    const ref = branch ? `${encodeURIComponent(branch)}/` : '';
    const url =
      `${this.apiBaseUrl}/repositories/${encodeURIComponent(workspace)}/` +
      `${encodeURIComponent(slug)}/src/${ref}${path}`;

    try {
      // Deliberately not `request`: that sends `Accept: application/json`,
      // which makes Bitbucket label raw files as JSON and sends the reader
      // down a JSON.parse it cannot survive for a requirements.txt or a
      // pyproject.toml. File contents are always read as text.
      return await this.requestText(url);
    } catch (error) {
      if (error instanceof BitbucketApiError && error.status === 404) {
        return undefined;
      }
      throw error;
    }
  }

  async listRootFiles(
    workspace: string,
    slug: string,
    branch?: string,
  ): Promise<string[]> {
    if (!workspace || !slug) {
      throw new Error('a workspace slug and repository slug are required');
    }

    const ref = branch ? `${encodeURIComponent(branch)}/` : '';
    const url =
      `${this.apiBaseUrl}/repositories/${encodeURIComponent(workspace)}/` +
      `${encodeURIComponent(
        slug,
      )}/src/${ref}?pagelen=${PAGE_SIZE}&fields=values.path`;

    try {
      const page: PagedResponse = await this.request(url);
      return ((page.values ?? []) as any[]).map(v => v.path).filter(Boolean);
    } catch (error) {
      if (error instanceof BitbucketApiError && error.status === 404) {
        return [];
      }
      throw error;
    }
  }

  /**
   * Fetches a URL as plain text.
   *
   * Separate from {@link request} because that one negotiates JSON, which is
   * wrong for raw file contents regardless of what the file happens to hold.
   */
  private async requestText(url: string): Promise<string> {
    this.requests++;

    const response = await this.fetchImpl(url, {
      headers: { Authorization: this.authorization },
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new BitbucketApiError(response.status, url, body);
    }

    return response.text();
  }

  private async request(url: string): Promise<any> {
    this.requests++;

    const response = await this.fetchImpl(url, {
      headers: {
        Authorization: this.authorization,
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new BitbucketApiError(response.status, url, body);
    }

    return response.json();
  }
}
