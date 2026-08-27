import type { FleetRepositorySummary } from '@internal/backstage-plugin-fleet-common';
import {
  bandCounts,
  directCommitCount,
  filterRepositories,
  technologyCounts,
} from './filter';

function repo(
  slug: string,
  overrides: Partial<FleetRepositorySummary> = {},
): FleetRepositorySummary {
  return {
    entityRef: `component:default/${slug}`,
    slug,
    name: slug,
    ...overrides,
  };
}

const scored = (
  slug: string,
  total: number,
  band: string,
  techStack?: string[],
) =>
  repo(slug, {
    techStack,
    score: {
      total,
      band,
      availableWeight: 85,
      computedAt: '2026-08-21T12:00:00.000Z',
    },
  });

const estate: FleetRepositorySummary[] = [
  scored('oxp-backend', 88, 'healthy', ['Node.js', 'Docker', 'React']),
  scored('crm', 55, 'needs-attention', ['Python', 'Docker']),
  scored('dead-repo', 4, 'critical', ['AWS SAM']),
  scored('idle-service', 6, 'critical', ['Python']),
  repo('brand-new'),
];

describe('filterRepositories', () => {
  it('returns everything when nothing is filtered', () => {
    expect(filterRepositories(estate)).toHaveLength(5);
    expect(filterRepositories(estate, {})).toHaveLength(5);
  });

  describe('by band', () => {
    it('narrows to one band', () => {
      const critical = filterRepositories(estate, { band: 'critical' });

      expect(critical.map(r => r.slug)).toEqual(['dead-repo', 'idle-service']);
    });

    it('treats a repository with no score as its own band', () => {
      const unscored = filterRepositories(estate, { band: 'unscored' });

      expect(unscored.map(r => r.slug)).toEqual(['brand-new']);
    });

    it('never lets an unscored repository match a real band', () => {
      for (const band of ['healthy', 'needs-attention', 'critical']) {
        expect(filterRepositories(estate, { band }).some(r => !r.score)).toBe(
          false,
        );
      }
    });
  });

  describe('by technology', () => {
    it('narrows to repositories carrying that label', () => {
      const docker = filterRepositories(estate, { technology: 'Docker' });

      expect(docker.map(r => r.slug)).toEqual(['oxp-backend', 'crm']);
    });

    it('excludes repositories with no derived stack', () => {
      expect(
        filterRepositories(estate, { technology: 'Docker' }).some(
          r => r.slug === 'brand-new',
        ),
      ).toBe(false);
    });

    it('matches exactly, not by substring', () => {
      // 'Node' must not match 'Node.js' -- the labels are a closed set.
      expect(filterRepositories(estate, { technology: 'Node' })).toEqual([]);
    });
  });

  describe('by text', () => {
    it('matches part of a slug', () => {
      expect(
        filterRepositories(estate, { query: 'oxp' }).map(r => r.slug),
      ).toEqual(['oxp-backend']);
    });

    it('ignores case and surrounding whitespace', () => {
      expect(
        filterRepositories(estate, { query: '  CRM ' }).map(r => r.slug),
      ).toEqual(['crm']);
    });

    it('treats an empty query as no filter', () => {
      expect(filterRepositories(estate, { query: '   ' })).toHaveLength(5);
    });

    it('returns nothing when nothing matches', () => {
      expect(filterRepositories(estate, { query: 'zzz' })).toEqual([]);
    });
  });

  it('applies every filter together', () => {
    const result = filterRepositories(estate, {
      band: 'critical',
      technology: 'Python',
    });

    expect(result.map(r => r.slug)).toEqual(['idle-service']);
  });

  it('preserves the order it was given, which is worst-first', () => {
    expect(filterRepositories(estate, { technology: 'Docker' })).toEqual([
      estate[0],
      estate[1],
    ]);
  });
});

describe('by direct commits', () => {
  const policy = (total: number, merges = 0) => ({
    total,
    merges,
    mainline: 20,
    windowDays: 30,
  });
  const withPolicy: FleetRepositorySummary[] = [
    repo('bypassing', { directCommits: policy(8, 2) }),
    repo('clean', { directCommits: policy(0) }),
    repo('unclassified'),
  ];

  it('keeps only repositories with a direct commit', () => {
    const kept = filterRepositories(withPolicy, { directCommitsOnly: true });

    expect(kept.map(r => r.slug)).toEqual(['bypassing']);
  });

  it('excludes a repository the pass has not classified', () => {
    // Not knowing is not the same as being clean; showing it under a filter
    // for policy breaches would accuse it of something unmeasured.
    const kept = filterRepositories(withPolicy, { directCommitsOnly: true });

    expect(kept.map(r => r.slug)).not.toContain('unclassified');
  });

  it('leaves everything alone when the filter is off', () => {
    expect(filterRepositories(withPolicy, {})).toHaveLength(3);
  });

  it('combines with the other filters rather than replacing them', () => {
    const mixed = [
      scored('bad-and-bypassing', 20, 'critical'),
      repo('bypassing-but-healthy', {
        directCommits: policy(3),
        score: {
          total: 90,
          band: 'healthy',
          availableWeight: 95,
          computedAt: '2026-08-26T12:00:00.000Z',
        },
      }),
    ];
    mixed[0].directCommits = policy(5);

    const kept = filterRepositories(mixed, {
      directCommitsOnly: true,
      band: 'critical',
    });

    expect(kept.map(r => r.slug)).toEqual(['bad-and-bypassing']);
  });
});

describe('directCommitCount', () => {
  it('counts repositories, not commits', () => {
    // The chip label is a repository count; using the commit total would read
    // as "94 repositories" on an estate of 95.
    const count = directCommitCount([
      repo('a', {
        directCommits: { total: 84, merges: 4, mainline: 115, windowDays: 30 },
      }),
      repo('b', {
        directCommits: { total: 1, merges: 0, mainline: 2, windowDays: 30 },
      }),
      repo('c', {
        directCommits: { total: 0, merges: 0, mainline: 9, windowDays: 30 },
      }),
      repo('d'),
    ]);

    expect(count).toBe(2);
  });

  it('is zero before anything has been classified', () => {
    expect(directCommitCount([repo('a'), repo('b')])).toBe(0);
  });
});

describe('technologyCounts', () => {
  it('counts each label across the estate', () => {
    expect(technologyCounts(estate)).toEqual([
      { label: 'Docker', count: 2 },
      { label: 'Python', count: 2 },
      { label: 'AWS SAM', count: 1 },
      { label: 'Node.js', count: 1 },
      { label: 'React', count: 1 },
    ]);
  });

  it('orders by frequency, then alphabetically for ties', () => {
    const labels = technologyCounts(estate).map(t => t.label);

    expect(labels.slice(0, 2)).toEqual(['Docker', 'Python']);
  });

  it('returns nothing when no repository has a derived stack', () => {
    expect(technologyCounts([repo('a'), repo('b')])).toEqual([]);
  });
});

describe('bandCounts', () => {
  it('counts every band including the unscored', () => {
    expect(bandCounts(estate)).toEqual({
      critical: 2,
      needsAttention: 1,
      healthy: 1,
      unscored: 1,
    });
  });

  it('reflects a filtered subset rather than the whole estate', () => {
    const docker = filterRepositories(estate, { technology: 'Docker' });

    expect(bandCounts(docker)).toEqual({
      critical: 0,
      needsAttention: 1,
      healthy: 1,
      unscored: 0,
    });
  });
});
