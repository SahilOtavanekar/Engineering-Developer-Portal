import type { EngineerProductivity } from '@internal/backstage-plugin-fleet-common';

/**
 * Sorting for the productivity table.
 *
 * **Client-side, deliberately.** The whole per-engineer breakdown arrives in
 * one response of about 4KB with no pagination -- every row is already in the
 * browser -- so a server sort would add a query parameter and a refetch per
 * click to reorder a list of thirteen. It would also put a network round trip
 * inside the two-second page-load budget for no gain.
 *
 * Kept out of `ProductivityPage.tsx` so it can be tested without rendering the
 * page: the interesting behaviour here is entirely in the comparator, and every
 * case below is one a table gets wrong by default.
 */

/** The sortable columns, keyed to what they read off a row. */
export type SortKey =
  | 'name'
  | 'commits'
  | 'activeRepositories'
  | 'pullRequestsCreated'
  | 'pullRequestsReviewed'
  | 'pullRequestsApproved'
  | 'pullRequestsMerged'
  | 'averageMergeHours'
  | 'lastCommitAt';

export type SortDirection = 'asc' | 'desc';

export interface Sort {
  key: SortKey;
  direction: SortDirection;
}

/**
 * The comparable value for one cell, or `undefined` where there is none.
 *
 * `undefined` is not a stand-in for zero here and the distinction is the whole
 * point -- see `sortEngineers`.
 */
function valueOf(
  row: EngineerProductivity,
  key: SortKey,
): string | number | undefined {
  switch (key) {
    case 'name':
      return row.name;
    case 'lastCommitAt': {
      // A date sorts as a number; comparing the ISO strings would happen to
      // work only while every one of them carries the same offset and
      // precision, which nothing guarantees.
      if (!row.lastCommitAt) return undefined;
      const at = Date.parse(row.lastCommitAt);
      return Number.isNaN(at) ? undefined : at;
    }
    case 'averageMergeHours':
      return row.averageMergeHours;
    default:
      return row[key];
  }
}

/**
 * Which way a column points when it is first clicked.
 *
 * Descending for a measure, because the question a volume column answers is
 * "who did the most" and opening with the smallest number makes the reader
 * click twice to ask it. Ascending for a name, because Z-to-A is nobody's first
 * guess at what an alphabetical column should do.
 */
export function initialDirection(key: SortKey): SortDirection {
  return key === 'name' ? 'asc' : 'desc';
}

/**
 * The next sort state for a click on `key`, cycling back to the default.
 *
 * Three states rather than two: without a way back, a reader who sorts by
 * `Approved` to answer one question has no route to the order the page opened
 * in, which is itself a considered ranking (commits, then pull requests, then
 * name) rather than an arbitrary starting point.
 */
export function nextSort(
  current: Sort | undefined,
  key: SortKey,
): Sort | undefined {
  if (current?.key !== key) return { key, direction: initialDirection(key) };
  if (current.direction === initialDirection(key)) {
    return { key, direction: current.direction === 'asc' ? 'desc' : 'asc' };
  }
  return undefined;
}

/**
 * Rows in the requested order, or the server's own order when none is set.
 *
 * **Absent values sort last whichever way the column points.** `averageMergeHours`
 * is absent for anyone with no merged pull requests of their own, and
 * `lastCommitAt` for someone who reviews but has never committed -- a real case
 * in this estate, which is why `RegisteredEngineer.email` is optional. Treating
 * those as zero would open "Avg merge, ascending" with a wall of em-dashes and
 * bury the fastest reviewer below them: "no data" is not the smallest value, it
 * is not a value.
 *
 * The name is the tiebreaker on every column. Two engineers level on `Merged`
 * would otherwise come out in whatever order the previous sort left them, so
 * the table would appear to reshuffle rows that had not changed.
 */
export function sortEngineers(
  rows: readonly EngineerProductivity[],
  sort: Sort | undefined,
): readonly EngineerProductivity[] {
  if (!sort) return rows;

  const direction = sort.direction === 'asc' ? 1 : -1;

  // A copy: `Array.prototype.sort` is in place, and this array is React state
  // owned by the fetch hook.
  return [...rows].sort((a, b) => {
    const left = valueOf(a, sort.key);
    const right = valueOf(b, sort.key);

    // Missing-last is applied outside the direction flip on purpose. Folding it
    // into the comparison would send the blanks to whichever end the arrow
    // pointed at, which is exactly the behaviour this exists to avoid.
    if (left === undefined || right === undefined) {
      if (left === undefined && right === undefined) {
        return a.name.localeCompare(b.name);
      }
      return left === undefined ? 1 : -1;
    }

    const primary =
      typeof left === 'string' && typeof right === 'string'
        ? left.localeCompare(right)
        : Number(left) - Number(right);

    return primary * direction || a.name.localeCompare(b.name);
  });
}

/** The `aria-sort` value for a column header. */
export function ariaSort(
  sort: Sort | undefined,
  key: SortKey,
): 'ascending' | 'descending' | 'none' {
  if (sort?.key !== key) return 'none';
  return sort.direction === 'asc' ? 'ascending' : 'descending';
}
