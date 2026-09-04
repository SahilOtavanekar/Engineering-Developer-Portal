import type { EngineerProductivity } from '@internal/backstage-plugin-fleet-common';
import {
  ariaSort,
  initialDirection,
  nextSort,
  sortEngineers,
  type Sort,
} from './sorting';

function engineer(
  name: string,
  over: Partial<EngineerProductivity> = {},
): EngineerProductivity {
  return {
    key: name.toLowerCase().replace(/\W+/g, '-'),
    name,
    email: `${name.toLowerCase().replace(/\W+/g, '.')}@demandai.co`,
    commits: 0,
    activeRepositories: 0,
    pullRequestsCreated: 0,
    pullRequestsMergedOfTheirOwn: 0,
    pullRequestsReviewed: 0,
    pullRequestsApproved: 0,
    pullRequestsMerged: 0,
    commitTrend: [],
    repositories: [],
    ...over,
  };
}

const names = (rows: readonly EngineerProductivity[]) => rows.map(r => r.name);

describe('sortEngineers', () => {
  it('leaves the order alone when nothing is sorted', () => {
    const rows = [engineer('Zoe'), engineer('Adam')];
    // The identity of the array matters, not just its contents: the default is
    // the server's considered ranking, so there is nothing to compute.
    expect(sortEngineers(rows, undefined)).toBe(rows);
  });

  it('does not mutate the array it is given', () => {
    const rows = [
      engineer('Zoe', { commits: 1 }),
      engineer('Adam', { commits: 9 }),
    ];
    sortEngineers(rows, { key: 'commits', direction: 'desc' });
    expect(names(rows)).toEqual(['Zoe', 'Adam']);
  });

  it('sorts a measure descending', () => {
    const rows = [
      engineer('Low', { commits: 4 }),
      engineer('High', { commits: 40 }),
      engineer('Mid', { commits: 12 }),
    ];
    expect(
      names(sortEngineers(rows, { key: 'commits', direction: 'desc' })),
    ).toEqual(['High', 'Mid', 'Low']);
  });

  it('sorts a name with locale collation, not by code unit', () => {
    const rows = [engineer('Ávila'), engineer('Adams'), engineer('Baker')];
    expect(
      names(sortEngineers(rows, { key: 'name', direction: 'asc' })),
    ).toEqual(['Adams', 'Ávila', 'Baker']);
  });

  it('sorts last commit by instant rather than by string', () => {
    const rows = [
      engineer('Older', { lastCommitAt: '2026-08-01T00:00:00.000Z' }),
      engineer('Newer', { lastCommitAt: '2026-08-30T12:00:00.000Z' }),
    ];
    expect(
      names(sortEngineers(rows, { key: 'lastCommitAt', direction: 'desc' })),
    ).toEqual(['Newer', 'Older']);
  });

  // The two cases the whole module exists for. `averageMergeHours` is absent
  // for anyone with no merged pull requests of their own, and `lastCommitAt`
  // for a reviewer who has never committed.
  describe('absent values', () => {
    const rows = [
      engineer('NoData'),
      engineer('Fast', { averageMergeHours: 0.5 }),
      engineer('Slow', { averageMergeHours: 96 }),
    ];

    it('puts them last when descending', () => {
      expect(
        names(
          sortEngineers(rows, { key: 'averageMergeHours', direction: 'desc' }),
        ),
      ).toEqual(['Slow', 'Fast', 'NoData']);
    });

    it('puts them last when ascending too, not first', () => {
      expect(
        names(
          sortEngineers(rows, { key: 'averageMergeHours', direction: 'asc' }),
        ),
      ).toEqual(['Fast', 'Slow', 'NoData']);
    });

    it('does not treat an absent value as zero', () => {
      // Zero is a real, and here the *fastest*, merge time. If absence sorted
      // as zero, NoData would outrank Fast on an ascending sort.
      const withZero = [
        engineer('NoData'),
        engineer('Instant', { averageMergeHours: 0 }),
      ];
      expect(
        names(
          sortEngineers(withZero, {
            key: 'averageMergeHours',
            direction: 'asc',
          }),
        ),
      ).toEqual(['Instant', 'NoData']);
    });

    it('sorts an unparseable date as absent rather than as 1970', () => {
      const bad = [
        engineer('Broken', { lastCommitAt: 'not-a-date' }),
        engineer('Real', { lastCommitAt: '2026-08-01T00:00:00.000Z' }),
      ];
      expect(
        names(sortEngineers(bad, { key: 'lastCommitAt', direction: 'asc' })),
      ).toEqual(['Real', 'Broken']);
    });

    it('falls back to the name when both are absent', () => {
      const both = [engineer('Zoe'), engineer('Adam')];
      expect(
        names(
          sortEngineers(both, { key: 'averageMergeHours', direction: 'desc' }),
        ),
      ).toEqual(['Adam', 'Zoe']);
    });
  });

  it('breaks a tie on the name, so equal rows never reshuffle', () => {
    const rows = [
      engineer('Zoe', { pullRequestsMerged: 5 }),
      engineer('Adam', { pullRequestsMerged: 5 }),
      engineer('Mia', { pullRequestsMerged: 5 }),
    ];
    for (const direction of ['asc', 'desc'] as const) {
      expect(
        names(sortEngineers(rows, { key: 'pullRequestsMerged', direction })),
      ).toEqual(['Adam', 'Mia', 'Zoe']);
    }
  });
});

describe('initialDirection', () => {
  it('opens a measure at its largest', () => {
    expect(initialDirection('commits')).toBe('desc');
  });

  it('opens a name at A', () => {
    expect(initialDirection('name')).toBe('asc');
  });
});

describe('nextSort', () => {
  it('starts a new column at its own initial direction', () => {
    expect(nextSort(undefined, 'commits')).toEqual({
      key: 'commits',
      direction: 'desc',
    });
    expect(nextSort(undefined, 'name')).toEqual({
      key: 'name',
      direction: 'asc',
    });
  });

  it('reverses on a second click', () => {
    expect(nextSort({ key: 'commits', direction: 'desc' }, 'commits')).toEqual({
      key: 'commits',
      direction: 'asc',
    });
  });

  it('returns to the default order on a third, rather than cycling forever', () => {
    const second = nextSort({ key: 'commits', direction: 'desc' }, 'commits');
    expect(nextSort(second, 'commits')).toBeUndefined();
  });

  it('switches columns without inheriting the previous direction', () => {
    const sort: Sort = { key: 'name', direction: 'desc' };
    expect(nextSort(sort, 'commits')).toEqual({
      key: 'commits',
      direction: 'desc',
    });
  });
});

describe('ariaSort', () => {
  it('reports none for an inactive column', () => {
    expect(ariaSort({ key: 'commits', direction: 'asc' }, 'name')).toBe('none');
    expect(ariaSort(undefined, 'commits')).toBe('none');
  });

  it('names the direction of the active one', () => {
    expect(ariaSort({ key: 'commits', direction: 'asc' }, 'commits')).toBe(
      'ascending',
    );
    expect(ariaSort({ key: 'commits', direction: 'desc' }, 'commits')).toBe(
      'descending',
    );
  });
});
