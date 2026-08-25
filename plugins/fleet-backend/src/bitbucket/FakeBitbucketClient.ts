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

/**
 * In-memory {@link BitbucketClient} for tests and local development.
 *
 * Generated data is deterministic -- same inputs, same output -- so tests that
 * assert on it do not become flaky. Proportions of the generated fleet mirror
 * what was measured on the real estate: roughly 40% of repositories have a
 * pipelines file, none have a catalog descriptor, and many have no detected
 * language.
 */
export class FakeBitbucketClient implements BitbucketClient {
  private readonly byWorkspace = new Map<string, BitbucketRepository[]>();
  private readonly commitsByRepo = new Map<string, BitbucketCommit[]>();
  private readonly branchesByRepo = new Map<string, BitbucketBranch[]>();
  private readonly runsByRepo = new Map<string, BitbucketPipelineRun[]>();
  private readonly deploymentsByRepo = new Map<string, BitbucketDeployment[]>();
  private readonly filesByRepo = new Map<string, string[]>();
  private readonly fileContentByRepo = new Map<
    string,
    Record<string, string>
  >();
  private readonly pullRequestsByRepo = new Map<
    string,
    BitbucketPullRequest[]
  >();
  private requests = 0;
  private readonly callsByMethod = new Map<string, number>();

  constructor(repositories: BitbucketRepository[] = []) {
    for (const repository of repositories) {
      const existing = this.byWorkspace.get(repository.workspace) ?? [];
      existing.push(repository);
      this.byWorkspace.set(repository.workspace, existing);
    }
  }

  /**
   * Builds a fake workspace of `count` repositories, shaped like the real one.
   */
  static withGeneratedRepositories(
    workspace: string,
    count: number,
  ): FakeBitbucketClient {
    const languages = [
      'java',
      'typescript',
      'python',
      undefined,
      undefined,
      'go',
    ];
    const projects = ['PORTAL', 'DATA', 'INFRA'];

    const repositories = Array.from({ length: count }, (_, i) => {
      // Fixed epoch so generated timestamps never depend on the clock.
      const created = new Date(Date.UTC(2023, 0, 1) + i * 86_400_000);
      const updated = new Date(Date.UTC(2026, 0, 1) + i * 3_600_000);

      return {
        workspace,
        slug: `service-${String(i + 1).padStart(3, '0')}`,
        name: `Service ${i + 1}`,
        description: i % 3 === 0 ? undefined : `Fake service number ${i + 1}`,
        url: `https://bitbucket.org/${workspace}/service-${String(
          i + 1,
        ).padStart(3, '0')}`,
        projectKey: projects[i % projects.length],
        defaultBranch: i % 5 === 0 ? 'master' : 'main',
        isPrivate: true,
        language: languages[i % languages.length],
        sizeBytes: 1_000_000 + i * 13_337,
        createdAt: created.toISOString(),
        updatedAt: updated.toISOString(),
      } satisfies BitbucketRepository;
    });

    return new FakeBitbucketClient(repositories);
  }

  /** Seeds commits for one repository, newest first. */
  withCommits(
    workspace: string,
    slug: string,
    commits: BitbucketCommit[],
  ): this {
    const sorted = [...commits].sort(
      (a, b) =>
        new Date(b.committedAt).getTime() - new Date(a.committedAt).getTime(),
    );
    this.commitsByRepo.set(`${workspace}/${slug}`, sorted);
    return this;
  }

  /**
   * Builds `count` commits ending at `latest`, one hour apart, cycling through
   * three authors. Deterministic, like the repository generator.
   */
  static generateCommits(count: number, latest: Date): BitbucketCommit[] {
    const authors = [
      ['Ada Lovelace', 'ada@demandai.co'],
      ['Alan Turing', 'alan@demandai.co'],
      ['Grace Hopper', 'grace@demandai.co'],
    ];
    return Array.from({ length: count }, (_, i) => {
      const [name, email] = authors[i % authors.length];
      return {
        hash: `commit${String(i + 1).padStart(6, '0')}`,
        committedAt: new Date(latest.getTime() - i * 3_600_000).toISOString(),
        message: `Change number ${i + 1}`,
        authorRaw: `${name} <${email}>`,
        authorName: name,
        authorEmail: email,
        // Every fourth commit is a merge, matching roughly what real
        // repositories look like.
        parentCount: i % 4 === 0 ? 2 : 1,
      } satisfies BitbucketCommit;
    });
  }

  withBranches(
    workspace: string,
    slug: string,
    branches: BitbucketBranch[],
  ): this {
    this.branchesByRepo.set(`${workspace}/${slug}`, branches);
    return this;
  }

  withDeployments(
    workspace: string,
    slug: string,
    deployments: BitbucketDeployment[],
  ): this {
    const sorted = [...deployments].sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
    this.deploymentsByRepo.set(`${workspace}/${slug}`, sorted);
    return this;
  }

  /** One completed deployment per named environment, newest first. */
  static generateDeployments(
    environments: Array<[name: string, type: string]>,
    latest: Date,
  ): BitbucketDeployment[] {
    return environments.map(([name, type], i) => ({
      uuid: `{deploy-${name}-${i}}`,
      number: i + 1,
      environmentName: name,
      environmentType: type,
      state: 'COMPLETED',
      releaseName: `#${100 + i}`,
      commitHash: `commit${i}`,
      createdAt: new Date(latest.getTime() - i * 3_600_000).toISOString(),
      lastUpdatedAt: new Date(latest.getTime() - i * 3_600_000).toISOString(),
    }));
  }

  withPipelineRuns(
    workspace: string,
    slug: string,
    runs: BitbucketPipelineRun[],
  ): this {
    this.runsByRepo.set(`${workspace}/${slug}`, runs);
    return this;
  }

  withPullRequests(
    workspace: string,
    slug: string,
    pullRequests: BitbucketPullRequest[],
  ): this {
    const sorted = [...pullRequests].sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
    this.pullRequestsByRepo.set(`${workspace}/${slug}`, sorted);
    return this;
  }

  /** `approved` reviewed PRs followed by `unreviewed` self-merged ones. */
  static generatePullRequests(
    approved: number,
    unreviewed: number,
    latest: Date,
    state = 'MERGED',
  ): BitbucketPullRequest[] {
    const make = (i: number, approvals: number) => ({
      id: i + 1,
      title: `Change ${i + 1}`,
      state,
      createdAt: new Date(
        latest.getTime() - (i + 1) * 86_400_000,
      ).toISOString(),
      updatedAt: new Date(latest.getTime() - i * 3_600_000).toISOString(),
      commentCount: approvals > 0 ? 2 : 0,
      approvalCount: approvals,
      participantCount: approvals,
      authorAccountId: `acct-${i % 3}`,
      authorName: `Dev ${i % 3}`,
      sourceBranch: `feature/${i + 1}`,
      destinationBranch: 'main',
    });
    return [
      ...Array.from({ length: approved }, (_, i) => make(i, 1)),
      ...Array.from({ length: unreviewed }, (_, i) => make(approved + i, 0)),
    ];
  }

  /** Seeds file contents, keyed by path. */
  withFileContent(
    workspace: string,
    slug: string,
    contents: Record<string, string>,
  ): this {
    this.fileContentByRepo.set(`${workspace}/${slug}`, contents);
    return this;
  }

  withRootFiles(workspace: string, slug: string, files: string[]): this {
    this.filesByRepo.set(`${workspace}/${slug}`, files);
    return this;
  }

  /** `active` fresh branches plus `stale` untouched ones, deterministically. */
  static generateBranches(
    active: number,
    stale: number,
    now: Date,
  ): BitbucketBranch[] {
    const fresh = Array.from({ length: active }, (_, i) => ({
      name: i === 0 ? 'main' : `feature/active-${i}`,
      lastCommitAt: new Date(now.getTime() - i * 86_400_000).toISOString(),
      lastCommitHash: `active${i}`,
    }));
    const old = Array.from({ length: stale }, (_, i) => ({
      name: `feature/stale-${i}`,
      lastCommitAt: new Date(
        now.getTime() - (200 + i) * 86_400_000,
      ).toISOString(),
      lastCommitHash: `stale${i}`,
    }));
    return [...fresh, ...old];
  }

  /** `successful` passing runs followed by `failed` failing ones. */
  static generatePipelineRuns(
    successful: number,
    failed: number,
    now: Date,
    refName = 'main',
  ): BitbucketPipelineRun[] {
    const make = (i: number, result: string) => ({
      uuid: `{run-${result}-${i}}`,
      buildNumber: i + 1,
      state: 'COMPLETED',
      result,
      refName,
      createdAt: new Date(now.getTime() - i * 3_600_000).toISOString(),
      durationSeconds: 120 + i,
    });
    return [
      ...Array.from({ length: successful }, (_, i) => make(i, 'SUCCESSFUL')),
      ...Array.from({ length: failed }, (_, i) =>
        make(successful + i, 'FAILED'),
      ),
    ];
  }

  get requestCount(): number {
    return this.requests;
  }

  /**
   * How many times one method was called.
   *
   * Total request count cannot show that a call was skipped, only that fewer
   * happened -- which any other change also produces.
   */
  requestsFor(method: string): number {
    return this.callsByMethod.get(method) ?? 0;
  }

  private record(method: string): void {
    this.requests++;
    this.callsByMethod.set(method, (this.callsByMethod.get(method) ?? 0) + 1);
  }

  async listRepositories(workspace: string): Promise<BitbucketRepository[]> {
    if (!workspace) {
      throw new Error('a workspace slug is required');
    }
    this.record('listRepositories');
    return [...(this.byWorkspace.get(workspace) ?? [])];
  }

  async listCommits(
    workspace: string,
    slug: string,
    options: ListCommitsOptions = {},
  ): Promise<BitbucketCommit[]> {
    if (!workspace || !slug) {
      throw new Error('a workspace slug and repository slug are required');
    }
    this.record('listCommits');

    const all = this.commitsByRepo.get(`${workspace}/${slug}`) ?? [];
    const cutoff = options.since?.getTime();
    if (cutoff === undefined) return [...all];

    return all.filter(c => new Date(c.committedAt).getTime() > cutoff);
  }

  async listBranches(
    workspace: string,
    slug: string,
  ): Promise<BitbucketBranch[]> {
    if (!workspace || !slug) {
      throw new Error('a workspace slug and repository slug are required');
    }
    this.record('listBranches');
    return [...(this.branchesByRepo.get(`${workspace}/${slug}`) ?? [])];
  }

  async listDeployments(
    workspace: string,
    slug: string,
    options: { limit?: number } = {},
  ): Promise<BitbucketDeployment[]> {
    if (!workspace || !slug) {
      throw new Error('a workspace slug and repository slug are required');
    }
    this.record('listDeployments');
    const all = this.deploymentsByRepo.get(`${workspace}/${slug}`) ?? [];
    return all.slice(0, options.limit ?? all.length);
  }

  async listPipelineRuns(
    workspace: string,
    slug: string,
    options: { limit?: number } = {},
  ): Promise<BitbucketPipelineRun[]> {
    if (!workspace || !slug) {
      throw new Error('a workspace slug and repository slug are required');
    }
    this.record('listPipelineRuns');
    const all = this.runsByRepo.get(`${workspace}/${slug}`) ?? [];
    return all.slice(0, options.limit ?? all.length);
  }

  async getFileContent(
    workspace: string,
    slug: string,
    path: string,
  ): Promise<string | undefined> {
    if (!workspace || !slug || !path) {
      throw new Error(
        'a workspace slug, repository slug and file path are required',
      );
    }
    this.record('getFileContent');
    return this.fileContentByRepo.get(`${workspace}/${slug}`)?.[path];
  }

  async listRootFiles(workspace: string, slug: string): Promise<string[]> {
    if (!workspace || !slug) {
      throw new Error('a workspace slug and repository slug are required');
    }
    this.record('listRootFiles');
    return [...(this.filesByRepo.get(`${workspace}/${slug}`) ?? [])];
  }

  async listPullRequests(
    workspace: string,
    slug: string,
    options: ListPullRequestsOptions = {},
  ): Promise<BitbucketPullRequest[]> {
    if (!workspace || !slug) {
      throw new Error('a workspace slug and repository slug are required');
    }
    this.record('listPullRequests');

    const all = this.pullRequestsByRepo.get(`${workspace}/${slug}`) ?? [];
    const byState = options.states
      ? all.filter(pr => options.states!.includes(pr.state))
      : all;
    const cutoff = options.since?.getTime();
    if (cutoff === undefined) return [...byState];

    return byState.filter(pr => new Date(pr.updatedAt).getTime() > cutoff);
  }
}
