import type { FleetRepositorySummary } from '@internal/backstage-plugin-fleet-common';
import {
  bandCounts,
  dormancyCounts,
  filterRepositories,
  problemCounts,
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
  scored('dead-repo', 4, 'at-risk', ['AWS SAM']),
  scored('idle-service', 6, 'at-risk', ['Python']),
  repo('brand-new'),
];

describe('filterRepositories', () => {
  it('returns everything when nothing is filtered', () => {
    expect(filterRepositories(estate)).toHaveLength(5);
    expect(filterRepositories(estate, {})).toHaveLength(5);
  });

  describe('by band', () => {
    it('narrows to one band', () => {
      const atRisk = filterRepositories(estate, { band: 'at-risk' });

      expect(atRisk.map(r => r.slug)).toEqual(['dead-repo', 'idle-service']);
    });

    /**
     * Score rows are append-only, so a repository last scored before At Risk
     * was renamed from `critical` still carries the old name. The segment that
     * offers this filter is built from the current name, so comparing raw
     * strings made "At risk (42)" filter to nothing -- which reads as a broken
     * filter rather than as a renamed band.
     */
    it('matches a repository still holding the pre-rename band name', () => {
      const legacy = [...estate, scored('old-score', 12, 'critical')];

      expect(
        filterRepositories(legacy, { band: 'at-risk' }).map(r => r.slug),
      ).toEqual(['dead-repo', 'idle-service', 'old-score']);
    });

    it('treats a repository with no score as its own band', () => {
      const unscored = filterRepositories(estate, { band: 'unscored' });

      expect(unscored.map(r => r.slug)).toEqual(['brand-new']);
    });

    it('never lets an unscored repository match a real band', () => {
      for (const band of ['healthy', 'needs-attention', 'at-risk']) {
        expect(filterRepositories(estate, { band }).some(r => !r.score)).toBe(
          false,
        );
      }
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
      band: 'at-risk',
      query: 'idle',
    });

    expect(result.map(r => r.slug)).toEqual(['idle-service']);
  });

  it('preserves the order it was given, which is worst-first', () => {
    expect(filterRepositories(estate, { band: 'at-risk' })).toEqual([
      estate[2],
      estate[3],
    ]);
  });
});

describe('problems across the estate', () => {
  const withProblems = (
    slug: string,
    top: Array<{ id: string; title: string; lost: number }>,
    dormancy?: 'never-started' | 'abandoned',
    band = 'at-risk',
  ) =>
    repo(slug, {
      problems: {
        top,
        lostPoints: top.reduce((a, p) => a + p.lost, 0),
        ...(dormancy ? { dormancy } : {}),
      },
      score: {
        total: 30,
        band,
        availableWeight: 100,
        computedAt: '2026-08-27T08:00:00.000Z',
      },
    });

  const readme = {
    id: 'readme-available',
    title: 'README available',
    lost: 10,
  };
  const pipeline = {
    id: 'pipeline-passing',
    title: 'Pipeline passing',
    lost: 16,
  };

  const problemEstate = [
    withProblems('a', [readme, pipeline]),
    withProblems('b', [readme]),
    withProblems('c', [pipeline]),
    withProblems('d', [], 'never-started'),
    repo('unscored'),
  ];

  describe('problemCounts', () => {
    it('counts repositories, not points', () => {
      // A lead fixing a class of problem wants to know how many places to
      // visit, which is why README on 29 repositories is the useful number.
      const counts = problemCounts(problemEstate);

      expect(counts.map(c => [c.id, c.count])).toEqual([
        ['pipeline-passing', 2],
        ['readme-available', 2],
      ]);
    });

    it('breaks a tie on points forfeited', () => {
      // Both sit on two repositories, so the more expensive one leads: pipeline
      // is costing 32 points against README's 20.
      const counts = problemCounts(problemEstate);

      expect(counts[0].id).toBe('pipeline-passing');
      expect(counts[0].lost).toBe(32);
      expect(counts[1].lost).toBe(20);
    });

    it('is empty before anything has been scored', () => {
      expect(problemCounts([repo('a'), repo('b')])).toEqual([]);
    });
  });

  describe('filtering by problem', () => {
    it('keeps only repositories carrying it', () => {
      const kept = filterRepositories(problemEstate, {
        problem: 'readme-available',
      });

      expect(kept.map(r => r.slug)).toEqual(['a', 'b']);
    });

    it('excludes a repository with no problems payload at all', () => {
      const kept = filterRepositories(problemEstate, {
        problem: 'readme-available',
      });

      expect(kept.map(r => r.slug)).not.toContain('unscored');
    });

    it('combines with the band filter', () => {
      const mixed = [
        withProblems('bad', [readme], undefined, 'at-risk'),
        withProblems('ok', [readme], undefined, 'healthy'),
      ];

      const kept = filterRepositories(mixed, {
        problem: 'readme-available',
        band: 'at-risk',
      });

      expect(kept.map(r => r.slug)).toEqual(['bad']);
    });
  });

  describe('dormancyCounts', () => {
    it('separates the three populations hiding behind one band', () => {
      // 42 never developed, 6 abandoned and 11 underperforming all read as
      // "below healthy" otherwise, and only 17 of them are worth a
      // conversation.
      const counts = dormancyCounts([
        ...problemEstate,
        withProblems('old', [], 'abandoned'),
      ]);

      expect(counts).toEqual({
        neverStarted: 1,
        abandoned: 1,
        underperforming: 3,
      });
    });

    it('does not count a healthy repository as underperforming', () => {
      const counts = dormancyCounts([
        withProblems('fine', [readme], undefined, 'healthy'),
      ]);

      expect(counts.underperforming).toBe(0);
    });
  });
});

describe('bandCounts', () => {
  it('counts every band including the unscored', () => {
    expect(bandCounts(estate)).toEqual({
      atRisk: 2,
      needsAttention: 1,
      healthy: 1,
      excellent: 0,
      unscored: 1,
    });
  });

  it('reflects a filtered subset rather than the whole estate', () => {
    const atRisk = filterRepositories(estate, { band: 'at-risk' });

    expect(bandCounts(atRisk)).toEqual({
      atRisk: 2,
      needsAttention: 0,
      healthy: 0,
      excellent: 0,
      unscored: 0,
    });
  });
});
