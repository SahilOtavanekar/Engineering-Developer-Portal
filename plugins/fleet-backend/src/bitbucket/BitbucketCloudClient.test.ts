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
});
