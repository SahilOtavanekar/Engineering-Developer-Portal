import type { EngineerProductivity } from '@internal/backstage-plugin-fleet-common';
import {
  nextSort as cycle,
  sortRows,
  type Comparable,
  type Sort as GenericSort,
  type SortDirection,
} from '../../sorting';

/**
 * Sorting for the productivity table.
 *
 * Only the parts specific to this table live here: what the columns are called,
 * how to read one off a row, and which way each opens. The comparator itself --
 * and in particular the rule that absent values sort last whichever way the
 * column points -- is in `plugins/fleet/src/sorting.ts`, shared with the health
 * dashboard so the two tables cannot drift.
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

export type Sort = GenericSort<SortKey>;
export type { SortDirection };

/**
 * The comparable value for one cell, or `undefined` where there is none.
 *
 * `undefined` is not a stand-in for zero and the distinction is load-bearing:
 * `averageMergeHours` is absent for anyone with no merged pull requests of
 * their own, and `lastCommitAt` for someone who reviews but has never
 * committed -- a real case in this estate, which is why
 * `RegisteredEngineer.email` is optional.
 */
function valueOf(row: EngineerProductivity, key: SortKey): Comparable {
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

/** The next sort state for a click on `key`, cycling back to the default. */
export function nextSort(
  current: Sort | undefined,
  key: SortKey,
): Sort | undefined {
  return cycle(current, key, initialDirection);
}

/**
 * Rows in the requested order, or the server's own order when none is set.
 *
 * That default is a considered ranking -- commits, then pull requests opened,
 * then name -- not an arbitrary starting point.
 */
export function sortEngineers(
  rows: readonly EngineerProductivity[],
  sort: Sort | undefined,
): readonly EngineerProductivity[] {
  return sortRows(rows, sort, valueOf, (a, b) => a.name.localeCompare(b.name));
}

export { ariaSort } from '../../sorting';
