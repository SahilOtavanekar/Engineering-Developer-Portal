import type { BitbucketClient } from '../bitbucket/types';

/**
 * A complete {@link BitbucketClient} that returns nothing, with any subset
 * overridden.
 *
 * Hand-written object literals break every time the interface gains a method.
 * Tests that only care about one call should say so, and stay silent about the
 * rest.
 */
export function stubBitbucketClient(
  overrides: Partial<BitbucketClient> = {},
): BitbucketClient {
  return {
    requestCount: 0,
    listRepositories: async () => [],
    listCommits: async () => [],
    listBranches: async () => [],
    listDeployments: async () => [],
    listPipelineRuns: async () => [],
    listPullRequests: async () => [],
    listRootFiles: async () => [],
    getFileContent: async () => undefined,
    ...overrides,
  };
}
