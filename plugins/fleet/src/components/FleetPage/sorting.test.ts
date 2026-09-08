import type { FleetRepositorySummary } from '@internal/backstage-plugin-fleet-common';
import {
  ariaSort,
  initialDirection,
  nextSort,
  sortRepositories,
} from './sorting';

function repo(
  slug: string,
  over: Partial<FleetRepositorySummary> = {},
): FleetRepositorySummary {
  return {
    entityRef: `component:default/${slug}`,
    slug,
    name: slug,
    ...over,
  } as FleetRepositorySummary;
}

const scored = (slug: string, total: number, band: string) =>
  repo(slug, {
    score: { total, band } as FleetRepositorySummary['score'],
  });

const slugs = (rows: readonly FleetRepositorySummary[]) =>
  rows.map(r => r.slug);

describe('sortRepositories', () => {
  it('returns the API order untouched when nothing is sorted', () => {
    const rows = [repo('b'), repo('a')];
    // Identity, not just contents: the default is the dashboard's product
    // ordering -- latest pipeline run, then worst score -- so there is nothing
    // to compute.
    expect(sortRepositories(rows, undefined)).toBe(rows);
  });

  describe('score', () => {
    const rows = [
      scored('mid', 55, 'needs-attention'),
      scored('best', 92, 'healthy'),
      repo('unscored'),
      scored('worst', 12, 'critical'),
    ];

    it('puts the highest first when descending', () => {
      expect(
        slugs(sortRepositories(rows, { key: 'score', direction: 'desc' })),
      ).toEqual(['best', 'mid', 'worst', 'unscored']);
    });

    it('keeps an unscored repository last when ascending too', () => {
      // "Not scored" is not a score of zero. If it sorted as one it would head
      // an ascending list and displace the repository that genuinely is worst.
      expect(
        slugs(sortRepositories(rows, { key: 'score', direction: 'asc' })),
      ).toEqual(['worst', 'mid', 'best', 'unscored']);
    });

    it('does not treat a zero score as absent', () => {
      const withZero = [repo('unscored'), scored('zero', 0, 'critical')];
      expect(
        slugs(sortRepositories(withZero, { key: 'score', direction: 'asc' })),
      ).toEqual(['zero', 'unscored']);
    });
  });

  describe('status', () => {
    // The bug this guards: sorting the band text gives critical, healthy,
    // needs-attention -- alphabetical, and an ordering of nothing.
    const rows = [
      scored('h', 92, 'healthy'),
      scored('c', 12, 'critical'),
      scored('n', 55, 'needs-attention'),
    ];

    it('ranks by severity, worst first, rather than alphabetically', () => {
      expect(
        slugs(sortRepositories(rows, { key: 'band', direction: 'desc' })),
      ).toEqual(['c', 'n', 'h']);
    });

    it('reverses to best first', () => {
      expect(
        slugs(sortRepositories(rows, { key: 'band', direction: 'asc' })),
      ).toEqual(['h', 'n', 'c']);
    });

    it('treats an unrecognised band as absent, not as healthy', () => {
      // Bands come from a scoring pass whose thresholds are configuration, so a
      // name this build does not know is possible. Ranking it 0 would quietly
      // present it as the healthiest thing on the estate.
      const odd = [
        scored('odd', 50, 'provisional'),
        scored('h', 92, 'healthy'),
      ];
      expect(
        slugs(sortRepositories(odd, { key: 'band', direction: 'asc' })),
      ).toEqual(['h', 'odd']);
      expect(
        slugs(sortRepositories(odd, { key: 'band', direction: 'desc' })),
      ).toEqual(['h', 'odd']);
    });

    it('sorts a repository with no score at all last', () => {
      const withNone = [repo('none'), scored('c', 12, 'critical')];
      expect(
        slugs(sortRepositories(withNone, { key: 'band', direction: 'desc' })),
      ).toEqual(['c', 'none']);
    });
  });

  describe('last commit', () => {
    const rows = [
      repo('older', { lastCommitAt: '2026-06-01T00:00:00.000Z' }),
      repo('never'),
      repo('newer', { lastCommitAt: '2026-08-30T12:00:00.000Z' }),
    ];

    it('puts the most recent first', () => {
      expect(
        slugs(
          sortRepositories(rows, { key: 'lastCommitAt', direction: 'desc' }),
        ),
      ).toEqual(['newer', 'older', 'never']);
    });

    it('keeps "Never" at the bottom when ascending, not at the top', () => {
      // 48 of this estate's repositories have no commit in the window. Sorted
      // as epoch zero they would bury every repository that does.
      expect(
        slugs(
          sortRepositories(rows, { key: 'lastCommitAt', direction: 'asc' }),
        ),
      ).toEqual(['older', 'newer', 'never']);
    });

    it('compares instants, not ISO strings', () => {
      const offsets = [
        repo('a', { lastCommitAt: '2026-08-30T23:00:00.000Z' }),
        repo('b', { lastCommitAt: '2026-08-31T00:30:00+02:00' }),
      ];
      // b is 22:30Z, so it is the earlier of the two despite sorting after as
      // text.
      expect(
        slugs(
          sortRepositories(offsets, { key: 'lastCommitAt', direction: 'asc' }),
        ),
      ).toEqual(['b', 'a']);
    });
  });

  describe('owner', () => {
    const owner = (name?: string, email?: string) =>
      ({ name, email } as FleetRepositorySummary['proposedOwner']);

    it('sorts by name, A to Z', () => {
      const rows = [
        repo('c', { proposedOwner: owner('Mohit Sharma') }),
        repo('a', { proposedOwner: owner('Avinash More') }),
        repo('b', { proposedOwner: owner('Brijesh Gupta') }),
      ];
      expect(
        slugs(sortRepositories(rows, { key: 'owner', direction: 'asc' })),
      ).toEqual(['a', 'b', 'c']);
    });

    it('falls back to the address, matching what the cell renders', () => {
      const rows = [
        repo('named', { proposedOwner: owner('Zoe Zhang') }),
        repo('addressed', {
          proposedOwner: owner(undefined, 'adam@demandai.co'),
        }),
      ];
      expect(
        slugs(sortRepositories(rows, { key: 'owner', direction: 'asc' })),
      ).toEqual(['addressed', 'named']);
    });

    it('sorts an unowned repository last in both directions', () => {
      const rows = [
        repo('unowned'),
        repo('owned', { proposedOwner: owner('Mia') }),
      ];
      for (const direction of ['asc', 'desc'] as const) {
        expect(
          slugs(sortRepositories(rows, { key: 'owner', direction })),
        ).toEqual(['owned', 'unowned']);
      }
    });
  });

  it('breaks a tie on the slug, so equal rows never reshuffle', () => {
    // 42 of 96 repositories here have ten or fewer commits ever, so identical
    // scores are common rather than theoretical.
    const rows = [
      scored('zeta', 50, 'needs-attention'),
      scored('alpha', 50, 'needs-attention'),
      scored('mid', 50, 'needs-attention'),
    ];
    for (const direction of ['asc', 'desc'] as const) {
      expect(
        slugs(sortRepositories(rows, { key: 'score', direction })),
      ).toEqual(['alpha', 'mid', 'zeta']);
    }
  });

  it('does not mutate the array it is given', () => {
    const rows = [scored('b', 10, 'critical'), scored('a', 90, 'healthy')];
    sortRepositories(rows, { key: 'score', direction: 'desc' });
    expect(slugs(rows)).toEqual(['b', 'a']);
  });
});

describe('initialDirection', () => {
  it('opens the owner at A', () => {
    expect(initialDirection('owner')).toBe('asc');
  });

  it('opens score, status and last commit at the top of their range', () => {
    // For status that means critical first, because BAND_SEVERITY runs
    // worst-highest.
    expect(initialDirection('score')).toBe('desc');
    expect(initialDirection('band')).toBe('desc');
    expect(initialDirection('lastCommitAt')).toBe('desc');
  });
});

describe('nextSort', () => {
  it('cycles descending, ascending, then back to the product order', () => {
    const first = nextSort(undefined, 'score');
    expect(first).toEqual({ key: 'score', direction: 'desc' });
    const second = nextSort(first, 'score');
    expect(second).toEqual({ key: 'score', direction: 'asc' });
    expect(nextSort(second, 'score')).toBeUndefined();
  });

  it('starts a new column fresh rather than inheriting a direction', () => {
    expect(nextSort({ key: 'score', direction: 'asc' }, 'owner')).toEqual({
      key: 'owner',
      direction: 'asc',
    });
    expect(nextSort({ key: 'owner', direction: 'desc' }, 'score')).toEqual({
      key: 'score',
      direction: 'desc',
    });
  });
});

describe('ariaSort', () => {
  it('reports the active column and none for the rest', () => {
    const sort = { key: 'score', direction: 'desc' } as const;
    expect(ariaSort(sort, 'score')).toBe('descending');
    expect(ariaSort(sort, 'owner')).toBe('none');
    expect(ariaSort(undefined, 'score')).toBe('none');
  });
});
