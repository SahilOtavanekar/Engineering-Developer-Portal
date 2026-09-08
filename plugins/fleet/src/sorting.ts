/**
 * Table sorting, shared by the Fleet plugin's two hand-rolled tables.
 *
 * **Why this is generic rather than written twice.** The productivity table
 * and the health dashboard both sort client-side over a payload that already
 * holds every row, and both have columns whose value is sometimes simply
 * absent. The absent case is the whole difficulty, and it is the one a second
 * implementation would get subtly different -- which is how the catalog table
 * and the fleet table came to look like two products before `surfaces.ts`
 * existed. The comparator lives here once; each page supplies only what is
 * specific to it, which is how to read a cell and what its columns are called.
 *
 * **Client-side, deliberately.** Both endpoints send the whole list in one
 * response with no pagination -- 96 repositories and 13 engineers -- so a
 * server sort would add a query parameter and a network round trip per click,
 * inside the two-second page-load budget, to reorder data already in the
 * browser.
 */

export type SortDirection = 'asc' | 'desc';

export interface Sort<K extends string> {
  key: K;
  direction: SortDirection;
}

/**
 * What a cell contributes to an ordering.
 *
 * `undefined` means the row has no value for this column -- not zero, and not
 * the empty string. See `sortRows`.
 */
export type Comparable = string | number | undefined;

/**
 * The next sort state for a click, cycling back to no sort at all.
 *
 * Three states rather than two. Both tables open in an order chosen for a
 * reason -- the dashboard's is "newest build week, then lowest score", which
 * answers the question the requirements document opens with -- and a two-state
 * toggle would leave a reader who sorted by one column with no route back to
 * it short of reloading the page.
 *
 * `initial` is injected because the sensible first direction is a property of
 * the column, not of this function: a measure opens at its largest, a name at
 * A. See the callers.
 */
export function nextSort<K extends string>(
  current: Sort<K> | undefined,
  key: K,
  initial: (key: K) => SortDirection,
): Sort<K> | undefined {
  if (current?.key !== key) return { key, direction: initial(key) };
  if (current.direction === initial(key)) {
    return { key, direction: current.direction === 'asc' ? 'desc' : 'asc' };
  }
  return undefined;
}

/** The `aria-sort` value for a column header. */
export function ariaSort<K extends string>(
  sort: Sort<K> | undefined,
  key: K,
): 'ascending' | 'descending' | 'none' {
  if (sort?.key !== key) return 'none';
  return sort.direction === 'asc' ? 'ascending' : 'descending';
}

/**
 * Rows in the requested order, or exactly the array given when none is set.
 *
 * **Absent values sort last whichever way the column points, and that is the
 * reason this function exists.** Every sortable column on both tables has rows
 * with nothing in it: a repository that has never been scored, one that has
 * never had a commit, one nobody owns; an engineer with no merged pull requests
 * of their own, or who reviews but has never committed. Sorting those as zero
 * or as the empty string opens an ascending sort with a screen of em-dashes and
 * buries the row the reader was looking for -- and on a column like a merge
 * time, zero is a real and meaningful value that must outrank "no data".
 *
 * The missing check therefore sits *outside* the direction flip. Folding it in
 * would send the blanks to whichever end the arrow happened to point at, which
 * is the behaviour being avoided.
 *
 * `tiebreak` keeps equal rows in a stable order. Without it, two repositories
 * on the same score come out in whatever order the previous sort left them, so
 * the table appears to reshuffle rows whose data has not changed.
 */
export function sortRows<T, K extends string>(
  rows: readonly T[],
  sort: Sort<K> | undefined,
  valueOf: (row: T, key: K) => Comparable,
  tiebreak: (a: T, b: T) => number,
): readonly T[] {
  if (!sort) return rows;

  const direction = sort.direction === 'asc' ? 1 : -1;

  // A copy: `Array.prototype.sort` works in place, and these arrays are React
  // state owned by a fetch hook.
  return [...rows].sort((a, b) => {
    const left = valueOf(a, sort.key);
    const right = valueOf(b, sort.key);

    if (left === undefined || right === undefined) {
      if (left === undefined && right === undefined) return tiebreak(a, b);
      return left === undefined ? 1 : -1;
    }

    const primary =
      typeof left === 'string' && typeof right === 'string'
        ? left.localeCompare(right)
        : Number(left) - Number(right);

    return primary * direction || tiebreak(a, b);
  });
}
