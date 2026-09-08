import type { FleetRepositorySummary } from '@internal/backstage-plugin-fleet-common';
import { BAND_SEVERITY } from '../../bands';
import {
  nextSort as cycle,
  sortRows,
  type Comparable,
  type Sort as GenericSort,
  type SortDirection,
} from '../../sorting';

/**
 * Sorting for the health dashboard table.
 *
 * Four of the seven columns sort: score, status, last commit and owner. The
 * other three are deliberately inert -- `Repository` is already the table's
 * identity and reads alphabetically at a glance, while `Created by` and
 * `Contributors` hold names whose useful ordering is by the activity behind
 * them rather than by spelling. A header that looks clickable and does nothing
 * is worse than one that plainly does not, so those render as plain text.
 *
 * The comparator, and the rule that absent values sort last whichever way the
 * column points, is in `plugins/fleet/src/sorting.ts` -- shared with the
 * productivity table.
 */

export type SortKey = 'score' | 'band' | 'lastCommitAt' | 'owner';

export type Sort = GenericSort<SortKey>;

/**
 * The comparable value for one cell, or `undefined` where there is none.
 *
 * Every one of these four columns has rows with nothing in it, and the table
 * already says so in words -- an unscored repository renders "Not scored", one
 * that has never had a commit renders "Never", one nobody owns renders an
 * em-dash. None of those is a low value; they are the absence of one, and
 * `sortRows` keeps them at the bottom in both directions.
 */
function valueOf(row: FleetRepositorySummary, key: SortKey): Comparable {
  switch (key) {
    case 'score':
      return row.score?.total;

    // The rank, never the label. See `BAND_SEVERITY`.
    case 'band':
      return row.score ? BAND_SEVERITY[row.score.band] : undefined;

    case 'lastCommitAt': {
      if (!row.lastCommitAt) return undefined;
      const at = Date.parse(row.lastCommitAt);
      return Number.isNaN(at) ? undefined : at;
    }

    // The same fallback the cell renders, so the order matches what is on
    // screen. A repository whose candidate carries neither a name nor an
    // address sorts as unowned, because that is what the cell shows.
    case 'owner':
      return row.proposedOwner?.name ?? row.proposedOwner?.email ?? undefined;

    default:
      return undefined;
  }
}

/**
 * Which way a column points when it is first clicked.
 *
 * Ascending for the owner, because Z-to-A is nobody's first guess at an
 * alphabetical column. Descending for the other three, which puts the highest
 * score, the most recent commit and -- because `BAND_SEVERITY` runs
 * worst-highest -- the critical repositories at the top.
 */
export function initialDirection(key: SortKey): SortDirection {
  return key === 'owner' ? 'asc' : 'desc';
}

/** The next sort state for a click on `key`, cycling back to the default. */
export function nextSort(
  current: Sort | undefined,
  key: SortKey,
): Sort | undefined {
  return cycle(current, key, initialDirection);
}

/**
 * Rows in the requested order, or the API's own order when none is set.
 *
 * **That default is a product decision, not an arbitrary starting point**: the
 * estate arrives ordered by the ISO week of the latest pipeline run, newest
 * first, then by score within the week -- worst on top. It answers the question the
 * requirements document opens with, so the third click on a column returns to
 * it rather than cycling back to a direction.
 *
 * The slug is the tiebreaker. Two repositories on the same score would
 * otherwise come out in whatever order the previous sort left them, and 42 of
 * this estate's 96 have ten or fewer commits ever, so ties are common rather
 * than theoretical.
 */
export function sortRepositories(
  rows: readonly FleetRepositorySummary[],
  sort: Sort | undefined,
): readonly FleetRepositorySummary[] {
  return sortRows(rows, sort, valueOf, (a, b) => a.slug.localeCompare(b.slug));
}

export { ariaSort } from '../../sorting';
