import { BitbucketCloudClient } from './BitbucketCloudClient';
import { FakeBitbucketClient } from './FakeBitbucketClient';
import type { BitbucketClient } from './types';

type ClientFactory = (repositorySlugs: string[]) => BitbucketClient;

const fakeClient: ClientFactory = slugs =>
  new FakeBitbucketClient(
    slugs.map(slug => ({
      workspace: 'demandai',
      slug,
      name: slug,
      url: `https://bitbucket.org/demandai/${slug}`,
      isPrivate: true,
      createdAt: '2024-01-01T00:00:00+00:00',
      updatedAt: '2026-01-01T00:00:00+00:00',
    })),
  );

const cloudClient: ClientFactory = slugs => {
  const fetchImpl = jest.fn(async (url: any) => {
    // Only the workspace listing gets repository payloads. Anything else --
    // commits, deployments, whatever is added next -- gets nothing, or it
    // would be handed repository payloads and map them into nonsense.
    const isWorkspaceListing = /\/repositories\/[^/]+\?/.test(String(url));
    const values = !isWorkspaceListing
      ? []
      : slugs.map(slug => ({
          slug,
          name: slug,
          links: { html: { href: `https://bitbucket.org/demandai/${slug}` } },
          is_private: true,
          created_on: '2024-01-01T00:00:00+00:00',
          updated_on: '2026-01-01T00:00:00+00:00',
        }));

    return {
      ok: true,
      status: 200,
      json: async () => ({ values }),
      text: async () => '',
    } as unknown as Response;
  });

  return new BitbucketCloudClient({
    credentials: { token: 'test' },
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
};

/**
 * Behaviour every BitbucketClient must exhibit, run against both
 * implementations. Without this the fake drifts from the real adapter and
 * every test built on the fake quietly stops meaning anything.
 */
const implementations: Array<[string, ClientFactory]> = [
  ['FakeBitbucketClient', fakeClient],
  ['BitbucketCloudClient', cloudClient],
];

describe.each(implementations)('%s contract', (_name, build) => {
  it('returns every repository in the workspace', async () => {
    const client = build(['alpha', 'beta', 'gamma']);

    const repos = await client.listRepositories('demandai');

    expect(repos.map(r => r.slug)).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('stamps the requested workspace onto every repository', async () => {
    const client = build(['alpha', 'beta']);

    const repos = await client.listRepositories('demandai');

    expect(repos.every(r => r.workspace === 'demandai')).toBe(true);
  });

  it('returns an empty list for a workspace with no repositories', async () => {
    const client = build([]);

    await expect(client.listRepositories('demandai')).resolves.toEqual([]);
  });

  it('rejects an empty workspace slug', async () => {
    const client = build([]);

    await expect(client.listRepositories('')).rejects.toThrow(
      'workspace slug is required',
    );
  });

  it('returns no commits for a repository that has none', async () => {
    const client = build(['alpha']);

    await expect(client.listCommits('demandai', 'alpha')).resolves.toEqual([]);
  });

  it('rejects an empty repository slug when listing commits', async () => {
    const client = build(['alpha']);

    await expect(client.listCommits('demandai', '')).rejects.toThrow(
      'repository slug are required',
    );
  });

  it('returns no deployments for a repository that has none', async () => {
    const client = build(['alpha']);

    await expect(client.listDeployments('demandai', 'alpha')).resolves.toEqual(
      [],
    );
  });

  it('rejects an empty repository slug when listing deployments', async () => {
    const client = build(['alpha']);

    await expect(client.listDeployments('demandai', '')).rejects.toThrow(
      'repository slug are required',
    );
  });

  it('counts requests', async () => {
    const client = build(['alpha']);

    expect(client.requestCount).toBe(0);
    await client.listRepositories('demandai');
    expect(client.requestCount).toBeGreaterThan(0);
  });
});

describe('FakeBitbucketClient.withGeneratedRepositories', () => {
  it('generates the requested number of repositories', async () => {
    const client = FakeBitbucketClient.withGeneratedRepositories(
      'demandai',
      95,
    );

    await expect(client.listRepositories('demandai')).resolves.toHaveLength(95);
  });

  it('is deterministic, so tests built on it cannot flake', async () => {
    const first = await FakeBitbucketClient.withGeneratedRepositories(
      'demandai',
      10,
    ).listRepositories('demandai');
    const second = await FakeBitbucketClient.withGeneratedRepositories(
      'demandai',
      10,
    ).listRepositories('demandai');

    expect(first).toEqual(second);
  });

  it('includes repositories with no detected language, as the real estate does', async () => {
    const repos = await FakeBitbucketClient.withGeneratedRepositories(
      'demandai',
      20,
    ).listRepositories('demandai');

    expect(repos.some(r => r.language === undefined)).toBe(true);
    expect(repos.some(r => r.language !== undefined)).toBe(true);
  });
});
