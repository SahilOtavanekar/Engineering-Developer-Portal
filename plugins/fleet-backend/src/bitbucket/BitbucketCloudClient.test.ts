import { BitbucketCloudClient } from './BitbucketCloudClient';
import { BitbucketApiError } from './errors';

const API = 'https://api.bitbucket.org/2.0';

/**
 * Payload shaped like a real Bitbucket Cloud response. Empty-string
 * description and absent language reflect what the live estate actually
 * returns -- both are common there.
 */
const repositoryPayload = {
  slug: 'oxp-backend',
  name: 'oxp-backend',
  description: '',
  links: { html: { href: 'https://bitbucket.org/demandai/oxp-backend' } },
  project: { key: 'OXP' },
  mainbranch: { name: 'develop' },
  is_private: true,
  language: 'java',
  size: 12_345_678,
  created_on: '2023-05-01T10:00:00+00:00',
  updated_on: '2026-08-19T12:00:00+00:00',
};

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/** Returns each queued response in order, recording the calls made. */
function stubFetch(...responses: Response[]) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl = jest.fn(async (url: any, init?: any) => {
    calls.push({ url: String(url), init });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected extra request to ${url}`);
    return next;
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

function client(fetchImpl: typeof fetch) {
  return new BitbucketCloudClient({
    credentials: { username: 'someone@example.com', appPassword: 'secret' },
    fetchImpl,
  });
}

describe('BitbucketCloudClient', () => {
  describe('listRepositories', () => {
    it('maps a Bitbucket payload onto the domain type', async () => {
      const { impl } = stubFetch(jsonResponse({ values: [repositoryPayload] }));

      const [repo] = await client(impl).listRepositories('demandai');

      expect(repo).toEqual({
        workspace: 'demandai',
        slug: 'oxp-backend',
        name: 'oxp-backend',
        description: undefined,
        url: 'https://bitbucket.org/demandai/oxp-backend',
        projectKey: 'OXP',
        defaultBranch: 'develop',
        isPrivate: true,
        language: 'java',
        sizeBytes: 12_345_678,
        createdAt: '2023-05-01T10:00:00+00:00',
        updatedAt: '2026-08-19T12:00:00+00:00',
      });
    });

    it('treats absent optional fields as undefined rather than empty strings', async () => {
      const sparse = {
        slug: 'demand-ai-website',
        created_on: '2024-01-01T00:00:00+00:00',
        updated_on: '2026-01-01T00:00:00+00:00',
      };
      const { impl } = stubFetch(jsonResponse({ values: [sparse] }));

      const [repo] = await client(impl).listRepositories('demandai');

      expect(repo.language).toBeUndefined();
      expect(repo.description).toBeUndefined();
      expect(repo.projectKey).toBeUndefined();
      expect(repo.defaultBranch).toBeUndefined();
      expect(repo.sizeBytes).toBeUndefined();
      // Falls back to the slug and a derived URL so the catalog never sees blanks.
      expect(repo.name).toBe('demand-ai-website');
      expect(repo.url).toBe('https://bitbucket.org/demandai/demand-ai-website');
      expect(repo.isPrivate).toBe(false);
    });

    it('follows pagination until Bitbucket stops returning a next link', async () => {
      const page2 = `${API}/repositories/demandai?page=2`;
      const { impl, calls } = stubFetch(
        jsonResponse({ values: [repositoryPayload], next: page2 }),
        jsonResponse({ values: [{ ...repositoryPayload, slug: 'crm' }] }),
      );

      const repos = await client(impl).listRepositories('demandai');

      expect(repos.map(r => r.slug)).toEqual(['oxp-backend', 'crm']);
      expect(calls).toHaveLength(2);
      expect(calls[1].url).toBe(page2);
    });

    it('requests only the fields it maps, at maximum page size', async () => {
      const { impl, calls } = stubFetch(jsonResponse({ values: [] }));

      await client(impl).listRepositories('demandai');

      expect(calls[0].url).toContain('/repositories/demandai?');
      expect(calls[0].url).toContain('pagelen=100');
      expect(calls[0].url).toContain('values.mainbranch.name');
    });

    it('counts its own requests, since Bitbucket returns no rate-limit headers', async () => {
      const { impl } = stubFetch(
        jsonResponse({ values: [], next: `${API}/x?page=2` }),
        jsonResponse({ values: [] }),
      );
      const subject = client(impl);

      expect(subject.requestCount).toBe(0);
      await subject.listRepositories('demandai');
      expect(subject.requestCount).toBe(2);
    });

    it('rejects an empty workspace instead of calling the API', async () => {
      const { impl, calls } = stubFetch();

      await expect(client(impl).listRepositories('')).rejects.toThrow(
        'workspace slug is required',
      );
      expect(calls).toHaveLength(0);
    });
  });

  describe('authentication', () => {
    it('uses Basic auth for a username and app password', async () => {
      const { impl, calls } = stubFetch(jsonResponse({ values: [] }));

      await client(impl).listRepositories('demandai');

      const expected = `Basic ${Buffer.from(
        'someone@example.com:secret',
      ).toString('base64')}`;
      expect((calls[0].init?.headers as any).Authorization).toBe(expected);
    });

    it('uses Bearer auth for an access token', async () => {
      const { impl, calls } = stubFetch(jsonResponse({ values: [] }));

      await new BitbucketCloudClient({
        credentials: { token: 'abc123' },
        fetchImpl: impl,
      }).listRepositories('demandai');

      expect((calls[0].init?.headers as any).Authorization).toBe(
        'Bearer abc123',
      );
    });
  });

  describe('fromIntegration', () => {
    const base = { host: 'bitbucket.org', apiBaseUrl: API };

    it('prefers a token when both credential forms are present', async () => {
      const { impl, calls } = stubFetch(jsonResponse({ values: [] }));

      await BitbucketCloudClient.fromIntegration(
        { ...base, username: 'u', appPassword: 'p', token: 't' },
        { fetchImpl: impl },
      ).listRepositories('demandai');

      expect((calls[0].init?.headers as any).Authorization).toBe('Bearer t');
    });

    it('honours the apiBaseUrl from the integration config', async () => {
      const { impl, calls } = stubFetch(jsonResponse({ values: [] }));

      await BitbucketCloudClient.fromIntegration(
        { ...base, apiBaseUrl: 'https://example.test/2.0/', token: 't' },
        { fetchImpl: impl },
      ).listRepositories('demandai');

      // Trailing slash on the configured base URL must not produce '//'.
      expect(calls[0].url).toContain('https://example.test/2.0/repositories/');
      expect(calls[0].url).not.toContain('2.0//repositories');
    });

    it('fails loudly when no usable credentials are configured', () => {
      expect(() => BitbucketCloudClient.fromIntegration({ ...base })).toThrow(
        /no usable credentials/,
      );
    });
  });

  describe('error handling', () => {
    it('raises BitbucketApiError carrying the status', async () => {
      const { impl } = stubFetch(jsonResponse({ error: 'nope' }, 403));

      await expect(client(impl).listRepositories('demandai')).rejects.toThrow(
        BitbucketApiError,
      );
    });

    it('marks 429 and 5xx as retryable, client errors as not', () => {
      const at = (status: number) =>
        new BitbucketApiError(status, 'https://x', '');

      expect(at(429).isRetryable).toBe(true);
      expect(at(503).isRetryable).toBe(true);
      expect(at(403).isRetryable).toBe(false);
      // 410 is what the deprecated enumeration endpoints return -- never retry.
      expect(at(410).isRetryable).toBe(false);
    });
  });

  describe('listPullRequests', () => {
    it('caps page size at 50, which is the endpoint limit', async () => {
      const { impl, calls } = stubFetch(jsonResponse({ values: [] }));

      await client(impl).listPullRequests('demandai', 'oxp-backend');

      // Bitbucket answers 400 'Invalid pagelen' above 50 here, unlike the
      // repositories and commits endpoints which accept 100.
      expect(calls[0].url).toContain('pagelen=50');
      expect(calls[0].url).not.toContain('pagelen=100');
    });

    it('asks for merged and open pull requests by default', async () => {
      const { impl, calls } = stubFetch(jsonResponse({ values: [] }));

      await client(impl).listPullRequests('demandai', 'oxp-backend');

      expect(calls[0].url).toContain('state=MERGED');
      expect(calls[0].url).toContain('state=OPEN');
    });

    it('takes the first approval, not the last', async () => {
      // Review time is how long the author waited to be unblocked. A second
      // reviewer arriving twenty minutes later did not prolong that wait.
      const { impl } = stubFetch(
        jsonResponse({
          values: [
            {
              id: 95,
              state: 'MERGED',
              created_on: '2026-08-18T06:22:40+00:00',
              updated_on: '2026-08-18T06:30:00+00:00',
              closed_on: '2026-08-18T06:27:44+00:00',
              participants: [
                {
                  approved: true,
                  participated_on: '2026-08-18T06:27:27+00:00',
                },
                {
                  approved: true,
                  participated_on: '2026-08-18T06:26:37+00:00',
                },
              ],
            },
          ],
        }),
      );

      const [pr] = await client(impl).listPullRequests(
        'demandai',
        'oxp-backend',
      );

      expect(pr.firstApprovalAt).toBe('2026-08-18T06:26:37.000Z');
      expect(pr.closedAt).toBe('2026-08-18T06:27:44+00:00');
    });

    it('ignores the timestamp of a reviewer who did not approve', async () => {
      const { impl } = stubFetch(
        jsonResponse({
          values: [
            {
              id: 96,
              state: 'MERGED',
              created_on: '2026-08-18T12:10:21+00:00',
              updated_on: '2026-08-18T12:10:32+00:00',
              participants: [
                {
                  approved: false,
                  participated_on: '2026-08-18T12:10:25+00:00',
                },
              ],
            },
          ],
        }),
      );

      const [pr] = await client(impl).listPullRequests(
        'demandai',
        'oxp-backend',
      );

      expect(pr.firstApprovalAt).toBeUndefined();
    });

    it('survives an approval Bitbucket gave no timestamp for', async () => {
      // 55 of 177 sampled merged pull requests had no approval at all, and a
      // null participated_on must not become an Invalid Date.
      const { impl } = stubFetch(
        jsonResponse({
          values: [
            {
              id: 97,
              state: 'MERGED',
              created_on: '2026-08-18T14:20:03+00:00',
              updated_on: '2026-08-18T14:22:24+00:00',
              participants: [{ approved: true, participated_on: null }],
            },
          ],
        }),
      );

      const [pr] = await client(impl).listPullRequests(
        'demandai',
        'oxp-backend',
      );

      expect(pr.firstApprovalAt).toBeUndefined();
      expect(pr.approvalCount).toBe(1);
    });

    it('leaves closedAt unset for a pull request still open', async () => {
      const { impl } = stubFetch(
        jsonResponse({
          values: [
            {
              id: 99,
              state: 'OPEN',
              created_on: '2026-08-21T06:18:21+00:00',
              updated_on: '2026-08-21T06:22:37+00:00',
              participants: [],
            },
          ],
        }),
      );

      const [pr] = await client(impl).listPullRequests(
        'demandai',
        'oxp-backend',
      );

      expect(pr.closedAt).toBeUndefined();
    });

    it('asks Bitbucket for both timestamps', async () => {
      const { impl, calls } = stubFetch(jsonResponse({ values: [] }));

      await client(impl).listPullRequests('demandai', 'oxp-backend');

      expect(calls[0].url).toContain('values.closed_on');
      expect(calls[0].url).toContain('values.participants.participated_on');
    });

    it('counts only reviewers who actually approved', async () => {
      const { impl } = stubFetch(
        jsonResponse({
          values: [
            {
              id: 98,
              state: 'MERGED',
              created_on: '2026-08-20T09:00:00+00:00',
              updated_on: '2026-08-20T10:00:00+00:00',
              comment_count: 2,
              participants: [
                { approved: true, role: 'REVIEWER' },
                { approved: false, role: 'REVIEWER' },
              ],
            },
          ],
        }),
      );

      const [pr] = await client(impl).listPullRequests(
        'demandai',
        'oxp-backend',
      );

      expect(pr.approvalCount).toBe(1);
      expect(pr.participantCount).toBe(2);
    });

    it('treats a repository with no pull requests as empty, not an error', async () => {
      const { impl } = stubFetch(jsonResponse({ error: 'nope' }, 404));

      await expect(
        client(impl).listPullRequests('demandai', 'oxp-backend'),
      ).resolves.toEqual([]);
    });

    it('stops paging at the cutoff', async () => {
      const { impl, calls } = stubFetch(
        jsonResponse({
          values: [
            {
              id: 2,
              state: 'MERGED',
              created_on: '2026-08-01T00:00:00+00:00',
              updated_on: '2026-08-20T00:00:00+00:00',
              participants: [],
            },
            {
              id: 1,
              state: 'MERGED',
              created_on: '2026-01-01T00:00:00+00:00',
              updated_on: '2026-01-02T00:00:00+00:00',
              participants: [],
            },
          ],
          next: 'https://api.bitbucket.org/2.0/x?page=2',
        }),
      );

      const prs = await client(impl).listPullRequests(
        'demandai',
        'oxp-backend',
        {
          since: new Date('2026-06-01T00:00:00.000Z'),
        },
      );

      expect(prs.map(p => p.id)).toEqual([2]);
      expect(calls).toHaveLength(1);
    });
  });

  describe('getFileContent', () => {
    /** A response whose body is plain text, as the src endpoint returns. */
    const textResponse = (body: string, status = 200): Response =>
      ({
        ok: status >= 200 && status < 300,
        status,
        text: async () => body,
        json: async () => JSON.parse(body),
      } as unknown as Response);

    it('reads a non-JSON manifest without trying to parse it', async () => {
      // This is the bug that broke 13 repositories: requesting JSON made
      // Bitbucket label requirements.txt as JSON, and parsing it threw.
      const requirements = `fastapi==0.110.0
boto3>=1.34
`;
      const { impl } = stubFetch(textResponse(requirements));

      await expect(
        client(impl).getFileContent('demandai', 'alpha', 'requirements.txt'),
      ).resolves.toBe(requirements);
    });

    it('reads a TOML manifest', async () => {
      const toml = `[build-system]
requires = ["setuptools"]
`;
      const { impl } = stubFetch(textResponse(toml));

      await expect(
        client(impl).getFileContent('demandai', 'alpha', 'pyproject.toml'),
      ).resolves.toBe(toml);
    });

    it('does not ask for JSON when fetching a file', async () => {
      const { impl, calls } = stubFetch(textResponse('x'));

      await client(impl).getFileContent('demandai', 'alpha', 'package.json');

      const headers = (calls[0].init?.headers ?? {}) as Record<string, string>;
      expect(headers.Accept).toBeUndefined();
    });

    it('reads from the given branch', async () => {
      const { impl, calls } = stubFetch(textResponse('{}'));

      await client(impl).getFileContent(
        'demandai',
        'alpha',
        'package.json',
        'develop',
      );

      expect(calls[0].url).toContain('/src/develop/package.json');
    });

    it('treats a missing file as absent rather than an error', async () => {
      const { impl } = stubFetch(textResponse('nope', 404));

      await expect(
        client(impl).getFileContent('demandai', 'alpha', 'package.json'),
      ).resolves.toBeUndefined();
    });

    it('propagates a real failure', async () => {
      const { impl } = stubFetch(textResponse('denied', 403));

      await expect(
        client(impl).getFileContent('demandai', 'alpha', 'package.json'),
      ).rejects.toThrow(BitbucketApiError);
    });

    it('rejects an empty path', async () => {
      const { impl, calls } = stubFetch();

      await expect(
        client(impl).getFileContent('demandai', 'alpha', ''),
      ).rejects.toThrow('file path are required');
      expect(calls).toHaveLength(0);
    });
  });
  describe('listRepositoryPermissions', () => {
    it('maps a permission payload onto the domain type', async () => {
      const { impl } = stubFetch(
        jsonResponse({
          values: [
            {
              permission: 'admin',
              user: {
                display_name: 'Makarand Prabhu',
                account_id: '712020:6f38332a',
                uuid: '{78bd5097}',
                nickname: 'Mark Praven',
              },
            },
          ],
        }),
      );

      const [entry] = await client(impl).listRepositoryPermissions(
        'demandai',
        'crm',
      );

      expect(entry).toEqual({
        permission: 'admin',
        displayName: 'Makarand Prabhu',
        accountId: '712020:6f38332a',
        uuid: '{78bd5097}',
        nickname: 'Mark Praven',
      });
    });

    it('treats a forbidden response as no permissions rather than failing', async () => {
      // The workspace-wide equivalent is 403 for this credential, and the
      // per-repository one could be too. Ownership degrades to commit history;
      // one repository must not fail the sweep.
      const { impl } = stubFetch(jsonResponse({ type: 'error' }, 403));

      await expect(
        client(impl).listRepositoryPermissions('demandai', 'crm'),
      ).resolves.toEqual([]);
    });

    it('treats a missing configuration as no permissions', async () => {
      const { impl } = stubFetch(jsonResponse({ type: 'error' }, 404));

      await expect(
        client(impl).listRepositoryPermissions('demandai', 'crm'),
      ).resolves.toEqual([]);
    });

    it('still raises anything that is not a 403 or 404', async () => {
      const { impl } = stubFetch(jsonResponse({ type: 'error' }, 500));

      await expect(
        client(impl).listRepositoryPermissions('demandai', 'crm'),
      ).rejects.toThrow(BitbucketApiError);
    });

    it('follows pagination', async () => {
      const { impl } = stubFetch(
        jsonResponse({
          values: [{ permission: 'admin', user: { display_name: 'One' } }],
          next: 'https://api.bitbucket.org/2.0/next-page',
        }),
        jsonResponse({
          values: [{ permission: 'write', user: { display_name: 'Two' } }],
        }),
      );

      const entries = await client(impl).listRepositoryPermissions(
        'demandai',
        'crm',
      );

      expect(entries.map(e => e.displayName)).toEqual(['One', 'Two']);
    });

    it('refuses a blank slug without spending a request', async () => {
      const { impl, calls } = stubFetch();

      await expect(
        client(impl).listRepositoryPermissions('demandai', ''),
      ).rejects.toThrow('repository slug are required');
      expect(calls).toHaveLength(0);
    });
  });

  describe('listDeployments', () => {
    /** Shaped like a real record from `demandai/oxp-backend`. */
    const deploymentPayload = {
      uuid: '{6b3f1a2c-0000-0000-0000-000000000001}',
      number: 412,
      environment: {
        name: 'production',
        environment_type: { name: 'Production' },
      },
      state: { name: 'COMPLETED' },
      release: {
        name: 'Deployment #412',
        commit: { hash: 'a1b2c3d4e5f6' },
      },
      created_on: '2026-08-20T09:00:00+00:00',
      last_update_time: '2026-08-20T09:04:00+00:00',
    };

    it('maps a Bitbucket payload onto the domain type', async () => {
      const { impl } = stubFetch(jsonResponse({ values: [deploymentPayload] }));

      const [deployment] = await client(impl).listDeployments(
        'demandai',
        'oxp-backend',
      );

      expect(deployment).toEqual({
        uuid: '{6b3f1a2c-0000-0000-0000-000000000001}',
        number: 412,
        environmentName: 'production',
        // Bitbucket's own normalisation. The estate spells environments
        // inconsistently -- dev, Staging, Test -- but the type is always one
        // of three values, so nothing downstream has to guess.
        environmentType: 'Production',
        state: 'COMPLETED',
        releaseName: 'Deployment #412',
        commitHash: 'a1b2c3d4e5f6',
        createdAt: '2026-08-20T09:00:00+00:00',
        lastUpdatedAt: '2026-08-20T09:04:00+00:00',
      });
    });

    it('returns the newest deployment first whatever order Bitbucket sends', async () => {
      const { impl } = stubFetch(
        jsonResponse({
          values: [
            {
              ...deploymentPayload,
              uuid: '{old}',
              created_on: '2026-08-01T09:00:00+00:00',
            },
            {
              ...deploymentPayload,
              uuid: '{new}',
              created_on: '2026-08-20T09:00:00+00:00',
            },
          ],
        }),
      );

      const deployments = await client(impl).listDeployments(
        'demandai',
        'oxp-backend',
      );

      expect(deployments.map(d => d.uuid)).toEqual(['{new}', '{old}']);
    });

    it('honours a limit after ordering, so the newest survive the cut', async () => {
      const { impl } = stubFetch(
        jsonResponse({
          values: [
            {
              ...deploymentPayload,
              uuid: '{old}',
              created_on: '2026-08-01T09:00:00+00:00',
            },
            {
              ...deploymentPayload,
              uuid: '{new}',
              created_on: '2026-08-20T09:00:00+00:00',
            },
          ],
        }),
      );

      const deployments = await client(impl).listDeployments(
        'demandai',
        'oxp-backend',
        { limit: 1 },
      );

      expect(deployments.map(d => d.uuid)).toEqual(['{new}']);
    });

    it('survives a record with no release or environment type', async () => {
      const { impl } = stubFetch(
        jsonResponse({
          values: [
            {
              uuid: '{bare}',
              environment: { name: 'sandbox' },
              state: { name: 'IN_PROGRESS' },
              created_on: '2026-08-20T09:00:00+00:00',
            },
          ],
        }),
      );

      const [deployment] = await client(impl).listDeployments(
        'demandai',
        'oxp-backend',
      );

      expect(deployment).toMatchObject({
        environmentName: 'sandbox',
        environmentType: undefined,
        state: 'IN_PROGRESS',
        releaseName: undefined,
        commitHash: undefined,
      });
    });

    it('treats a repository with deployments disabled as having none', async () => {
      // 404 here means the feature was never turned on, not that the request
      // was wrong. One such repository must not fail the whole sync pass.
      const { impl } = stubFetch(jsonResponse({ type: 'error' }, 404));

      await expect(
        client(impl).listDeployments('demandai', 'oxp-backend'),
      ).resolves.toEqual([]);
    });

    it('still raises anything that is not a 404', async () => {
      const { impl } = stubFetch(jsonResponse({ type: 'error' }, 403));

      await expect(
        client(impl).listDeployments('demandai', 'oxp-backend'),
      ).rejects.toThrow(BitbucketApiError);
    });

    it('refuses a blank slug without spending a request', async () => {
      const { impl, calls } = stubFetch();

      await expect(
        client(impl).listDeployments('demandai', ''),
      ).rejects.toThrow('repository slug are required');
      expect(calls).toHaveLength(0);
    });
  });
});
