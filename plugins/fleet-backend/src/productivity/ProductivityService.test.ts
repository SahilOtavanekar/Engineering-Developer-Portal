import { ConfigReader } from '@backstage/config';
import { mockServices } from '@backstage/backend-test-utils';
import { readIdentityRegister } from '../identity/identityRegister';
import { bucketForWindow, ProductivityService } from './ProductivityService';
import type { ProductivityStore } from '../database/ProductivityStore';

const SINCE = new Date('2026-05-29T00:00:00.000Z');
const NOW_ISO = new Date('2026-08-27T00:00:00.000Z');

/**
 * The register shape this estate actually has: someone with two addresses,
 * someone with none, and an address belonging to no person.
 */
const register = () =>
  readIdentityRegister(
    new ConfigReader({
      people: {
        'makarand-prabhu': {
          name: 'Makarand Prabhu',
          email: 'makarand.prabhu@demandai.co',
          aliases: ['makarand.r.prabhu@gmail.com'],
        },
        'brijesh-gupta': {
          name: 'Brijesh Gupta',
          email: 'brijesh.gupta@demandai.co',
        },
        // Reviews but never commits, so has no address at all.
        'saideep-narayan-avhad': { name: 'Saideep Narayan Avhad' },
      },
      notPeople: ['noreply@anthropic.com'],
    }),
    mockServices.logger.mock(),
  );

/** A store returning exactly what each test needs, nothing more. */
function stubStore(over: Partial<Record<string, any[]>> = {}) {
  return {
    commitsByAuthor: async () => over.commits ?? [],
    commitTrendByAuthor: async () => over.trend ?? [],
    authoredPullRequests: async () => over.authored ?? [],
    participation: async () => over.participation ?? [],
    mergedBy: async () => over.mergedBy ?? [],
    repositoriesWithActivity: async () => over.repositories ?? ['crm'],
    repositoriesByAuthor: async () => over.authorRepositories ?? [],
  } as unknown as ProductivityStore;
}

const service = (store: ProductivityStore) =>
  new ProductivityService({
    store,
    register: register(),
    logger: mockServices.logger.mock(),
  });

const window = { workspace: 'demandai', since: SINCE };

describe('ProductivityService', () => {
  it('sums a person who commits under more than one address', async () => {
    // The whole reason the register exists: raw addresses would report Makarand
    // as two engineers with 111 and 6 commits.
    const result = await service(
      stubStore({
        commits: [
          {
            email: 'makarand.prabhu@demandai.co',
            commits: 111,
            repositories: 1,
            lastCommitAt: new Date('2026-08-01T00:00:00.000Z'),
          },
          {
            email: 'makarand.r.prabhu@gmail.com',
            commits: 6,
            repositories: 1,
            lastCommitAt: new Date('2026-08-20T00:00:00.000Z'),
          },
        ],
      }),
    ).overview(window);

    expect(result.engineers).toHaveLength(1);
    expect(result.engineers[0]).toMatchObject({
      name: 'Makarand Prabhu',
      commits: 117,
      // A max, not a sum: the same repository under two addresses is one
      // repository, and adding them would overstate his reach.
      activeRepositories: 1,
      lastCommitAt: '2026-08-20T00:00:00.000Z',
    });
  });

  it('bridges commits and pull requests onto one person', async () => {
    // Commits carry an address, pull requests carry a display name and no
    // address at all. Both have to land on the same engineer.
    const result = await service(
      stubStore({
        commits: [
          {
            email: 'brijesh.gupta@demandai.co',
            commits: 40,
            repositories: 3,
            lastCommitAt: null,
          },
        ],
        authored: [
          {
            name: 'Brijesh Gupta',
            created: 12,
            merged: 10,
            averageMergeHours: 3.5,
          },
        ],
        participation: [{ name: 'Brijesh Gupta', reviewed: 9, approved: 7 }],
        mergedBy: [{ name: 'Brijesh Gupta', merged: 15 }],
      }),
    ).overview(window);

    expect(result.engineers).toHaveLength(1);
    expect(result.engineers[0]).toMatchObject({
      name: 'Brijesh Gupta',
      commits: 40,
      pullRequestsCreated: 12,
      pullRequestsMergedOfTheirOwn: 10,
      pullRequestsReviewed: 9,
      pullRequestsApproved: 7,
      pullRequestsMerged: 15,
      averageMergeHours: 3.5,
    });
  });

  it('includes someone who reviews but has never committed', async () => {
    // Found in the real data: a reviewer with no commits and therefore no
    // address. Requiring an address would have dropped them entirely.
    const result = await service(
      stubStore({
        participation: [
          { name: 'Saideep Narayan Avhad', reviewed: 4, approved: 3 },
        ],
      }),
    ).overview(window);

    expect(result.engineers[0]).toMatchObject({
      name: 'Saideep Narayan Avhad',
      commits: 0,
      pullRequestsReviewed: 4,
      pullRequestsApproved: 3,
    });
    expect(result.engineers[0].email).toBeUndefined();
    expect(result.unattributed.pullRequestNames).toEqual([]);
  });

  it('leaves an address that belongs to nobody out of the figures', async () => {
    const result = await service(
      stubStore({
        commits: [
          {
            email: 'noreply@anthropic.com',
            commits: 32,
            repositories: 4,
            lastCommitAt: null,
          },
        ],
      }),
    ).overview(window);

    expect(result.engineers).toEqual([]);
    // Excluded, not unattributed: nothing for anyone to fix.
    expect(result.unattributed.commitAddresses).toEqual([]);
    expect(result.unattributed.commits).toBe(0);
  });

  it('names an unregistered engineer rather than dropping them', async () => {
    // Someone missing from the register looks exactly like someone who did
    // nothing, and only one of those is worth a conversation.
    const result = await service(
      stubStore({
        commits: [
          {
            email: 'newjoiner@demandai.co',
            commits: 25,
            repositories: 2,
            lastCommitAt: null,
          },
        ],
        authored: [
          {
            name: 'Someone Unknown',
            created: 3,
            merged: 1,
            averageMergeHours: null,
          },
        ],
      }),
    ).overview(window);

    expect(result.engineers).toEqual([]);
    expect(result.unattributed).toMatchObject({
      commitAddresses: ['newjoiner@demandai.co'],
      pullRequestNames: ['Someone Unknown'],
      commits: 25,
    });
  });

  it('sums repository commits across both addresses of one person', async () => {
    // The failure this guards: Makarand touching `crm` under both addresses
    // would otherwise report as two rows, or as whichever arrived last.
    const result = await service(
      stubStore({
        authorRepositories: [
          { email: 'makarand.prabhu@demandai.co', slug: 'crm', commits: 7 },
          { email: 'makarand.r.prabhu@gmail.com', slug: 'crm', commits: 3 },
          { email: 'makarand.prabhu@demandai.co', slug: 'dxp', commits: 20 },
        ],
      }),
    ).overview(window);

    expect(result.engineers[0].repositories).toEqual([
      { slug: 'dxp', commits: 20 },
      { slug: 'crm', commits: 10 },
    ]);
  });

  it('gives a reviewer with no commits an empty repository list', async () => {
    const result = await service(
      stubStore({
        participation: [
          { name: 'Saideep Narayan Avhad', reviewed: 4, approved: 3 },
        ],
      }),
    ).overview(window);

    expect(result.engineers[0].repositories).toEqual([]);
  });

  it('reports the bucket the trend was computed with', async () => {
    const result = await service(stubStore()).overview(window);

    expect(result.trendBucket).toBe('week');
  });

  it('orders the commit trend oldest first', async () => {
    const result = await service(
      stubStore({
        trend: [
          {
            email: 'brijesh.gupta@demandai.co',
            start: new Date('2026-08-01T00:00:00.000Z'),
            commits: 5,
          },
          {
            email: 'brijesh.gupta@demandai.co',
            start: new Date('2026-06-01T00:00:00.000Z'),
            commits: 9,
          },
        ],
      }),
    ).overview(window);

    expect(result.engineers[0].commitTrend).toEqual([
      { start: '2026-06-01T00:00:00.000Z', commits: 9 },
      { start: '2026-08-01T00:00:00.000Z', commits: 5 },
    ]);
  });

  it('merges trend months arriving under two addresses of one person', async () => {
    const result = await service(
      stubStore({
        trend: [
          {
            email: 'makarand.prabhu@demandai.co',
            start: new Date('2026-07-01T00:00:00.000Z'),
            commits: 4,
          },
          {
            email: 'makarand.r.prabhu@gmail.com',
            start: new Date('2026-07-01T00:00:00.000Z'),
            commits: 2,
          },
        ],
      }),
    ).overview(window);

    expect(result.engineers[0].commitTrend).toEqual([
      { start: '2026-07-01T00:00:00.000Z', commits: 6 },
    ]);
  });

  it('ranks by commits, then by pull requests opened', async () => {
    const result = await service(
      stubStore({
        commits: [
          {
            email: 'brijesh.gupta@demandai.co',
            commits: 10,
            repositories: 1,
            lastCommitAt: null,
          },
          {
            email: 'makarand.prabhu@demandai.co',
            commits: 10,
            repositories: 1,
            lastCommitAt: null,
          },
        ],
        authored: [
          {
            name: 'Makarand Prabhu',
            created: 7,
            merged: 2,
            averageMergeHours: null,
          },
        ],
      }),
    ).overview(window);

    expect(result.engineers.map(e => e.name)).toEqual([
      'Makarand Prabhu',
      'Brijesh Gupta',
    ]);
  });

  it('reports the window and repository it was asked for', async () => {
    const until = new Date('2026-08-01T00:00:00.000Z');
    const result = await service(stubStore()).overview({
      ...window,
      until,
      repositorySlug: 'crm',
    });

    expect(result.window).toEqual({
      since: SINCE.toISOString(),
      until: until.toISOString(),
      repositorySlug: 'crm',
    });
    expect(result.repositories).toEqual(['crm']);
  });

  it('omits an average where nothing merged, rather than reporting zero', async () => {
    const result = await service(
      stubStore({
        authored: [
          {
            name: 'Brijesh Gupta',
            created: 2,
            merged: 0,
            averageMergeHours: null,
          },
        ],
      }),
    ).overview(window);

    expect(result.engineers[0].averageMergeHours).toBeUndefined();
  });

  it('returns nobody for a period with no activity', async () => {
    const result = await service(stubStore()).overview(window);

    expect(result.engineers).toEqual([]);
    expect(result.unattributed.commits).toBe(0);
  });
});

describe('bucketForWindow', () => {
  const days = (n: number) =>
    new Date(NOW_ISO.getTime() - n * 24 * 60 * 60 * 1000);

  it('buckets a month by day, so it is not a single bar', () => {
    // "This month" bucketed monthly is one bar, which cannot show a trend.
    expect(bucketForWindow(days(31), NOW_ISO)).toBe('day');
  });

  it('buckets 90 days by week', () => {
    // Monthly gives 4 bars, the last often a one-day stub. Weekly gives 14.
    expect(bucketForWindow(days(90), NOW_ISO)).toBe('week');
  });

  it('buckets a quarter by week', () => {
    expect(bucketForWindow(days(92), NOW_ISO)).toBe('week');
  });

  it('falls back to months for a window longer than the page offers', () => {
    expect(bucketForWindow(days(400), NOW_ISO)).toBe('month');
  });

  it('measures to now when the window is open-ended', () => {
    // Every period except "last month" and "last quarter" has no `until`.
    expect(bucketForWindow(new Date(Date.now() - 10 * 86_400_000))).toBe('day');
  });
});
