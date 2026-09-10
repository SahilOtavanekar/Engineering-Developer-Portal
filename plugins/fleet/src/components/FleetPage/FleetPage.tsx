import { useMemo, useState, type CSSProperties } from 'react';
import { useApi, fetchApiRef } from '@backstage/frontend-plugin-api';
import type { FleetOverview } from '@internal/backstage-plugin-fleet-common';
import { Flex, Link, Skeleton, Text } from '@backstage/ui';
import useAsync from 'react-use/esm/useAsync';
import { timeAgo } from '../../format';
import { bandLabel, bandText } from '../../bands';
import { filterRepositories, type FleetFilters } from '../../filter';
import { FleetFiltersBar } from './FleetFilters';
import {
  ariaSort,
  nextSort,
  sortRepositories,
  type Sort,
  type SortKey,
} from './sorting';
import {
  NUMERIC,
  fixedTable,
  headerCell,
  nowrapCell,
  tablePanel,
  tableScroll,
  truncatedCell,
} from '../../surfaces';

/**
 * The columns, and the width each one gets.
 *
 * Percentages total 100. They are deliberately uneven: `Score` holds at most
 * three characters where `Repository` holds names like
 * `daarwyn-user-mgmt-services`, and the automatic table layout's instinct to
 * even them out is exactly the behaviour being replaced here.
 */
const COLUMNS: ReadonlyArray<{
  heading: string;
  width: string;
  /** Absent means the header is plain text, not a control. */
  sort?: SortKey;
}> = [
  { heading: 'Repository', width: '23%' },
  { heading: 'Score', width: '7%', sort: 'score' },
  { heading: 'Status', width: '12%', sort: 'band' },
  { heading: 'Last commit', width: '11%', sort: 'lastCommitAt' },
  { heading: 'Created by', width: '13%' },
  { heading: 'Contributors', width: '19%' },
  { heading: 'Owner', width: '15%', sort: 'owner' },
];

/**
 * A column heading that is also its sort control.
 *
 * A button rather than a click handler on the cell: a bare `onClick` on a `th`
 * cannot be reached by keyboard and is announced as nothing, which is the usual
 * way a hand-rolled sortable table becomes mouse-only. Re-declares the capitals
 * and letter-spacing that user-agent button styles drop.
 */
const sortButton: CSSProperties = {
  appearance: 'none',
  background: 'none',
  border: 'none',
  padding: 0,
  margin: 0,
  width: '100%',
  font: 'inherit',
  color: 'inherit',
  textAlign: 'inherit',
  textTransform: 'inherit',
  letterSpacing: 'inherit',
  whiteSpace: 'nowrap',
  cursor: 'pointer',
};

/**
 * The sort direction, laid over the cell's padding rather than set beside the
 * heading.
 *
 * Measured on the productivity table first, where seven of nine headings had
 * no room left after their padding and one was already overflowing. Taking the
 * arrow out of flow costs the heading no width and cannot reflow a
 * fixed-layout column, so it works whatever the label happens to be.
 */
const caret: CSSProperties = {
  position: 'absolute',
  top: '50%',
  right: '5px',
  transform: 'translateY(-50%)',
  fontSize: '0.6rem',
  lineHeight: 1,
  color: 'var(--portal-accent)',
  // The label is the click target; an arrow that swallowed the pointer would
  // make the active column the one header that stopped responding.
  pointerEvents: 'none',
};

/**
 * Contributor names for one table cell.
 *
 * Truncated at three: measured across this estate the busiest repository has
 * five in 90 days, so this rarely fires -- but one repository gaining a dozen
 * must not stretch the row and push every other column off screen.
 */
function formatContributors(names: string[]): string {
  const shown = names.slice(0, 3).join(' · ');
  return names.length > 3 ? `${shown} +${names.length - 3}` : shown;
}

function useFleet() {
  const { fetch } = useApi(fetchApiRef);

  return useAsync(async (): Promise<FleetOverview> => {
    const response = await fetch('plugin://fleet/repositories');
    if (!response.ok) {
      throw new Error(
        `Failed to load the health dashboard: ${response.status} ${response.statusText}`,
      );
    }
    return response.json();
  }, [fetch]);
}

/**
 * The estate, worst first.
 *
 * This answers the question the requirements document opens with -- "which
 * repositories require attention" -- which until now could only be answered by
 * querying the database directly.
 *
 * Ordering and counts come from the API rather than being computed here, so
 * every consumer agrees on what "worst" means.
 */
export function FleetPage() {
  const { value: fleet, loading, error } = useFleet();
  const [filters, setFilters] = useState<FleetFilters>({});
  // `undefined` is the API's own ordering -- newest build week, then worst
  // score -- which is what the page opens in and what a third click returns to.
  const [sort, setSort] = useState<Sort | undefined>();

  // Memoised so the empty-array fallback does not produce a fresh reference
  // on every render, which would defeat the filter memo below.
  const repositories = useMemo(() => fleet?.repositories ?? [], [fleet]);
  const filtered = useMemo(
    () => filterRepositories(repositories, filters),
    [repositories, filters],
  );
  // Sorting after filtering, not before: the order of a list the reader cannot
  // see is not worth computing, and re-sorting on every filter keystroke would
  // be.
  const visible = useMemo(
    () => sortRepositories(filtered, sort),
    [filtered, sort],
  );

  if (loading) {
    return <Skeleton style={{ height: '20rem' }} />;
  }

  if (error) {
    return (
      <Text color="secondary">
        Could not load the health dashboard. {error.message}
      </Text>
    );
  }

  if (!fleet || fleet.repositories.length === 0) {
    return (
      <Text color="secondary">
        No repositories ingested yet. They appear after the next Bitbucket
        synchronisation.
      </Text>
    );
  }

  return (
    <Flex direction="column" gap="5">
      <FleetFiltersBar
        repositories={repositories}
        visibleCount={visible.length}
        filters={filters}
        onChange={setFilters}
      />

      {visible.length === 0 ? (
        <Text color="secondary">No repositories match these filters.</Text>
      ) : (
        // The table is given a card of its own, so it reads as a dashboard
        // surface rather than as markup sitting directly on the page. The
        // scroll lives on the inner wrapper: putting it on the panel would
        // scroll the rounded corners and the shadow along with the rows.
        <div style={tablePanel}>
          <div style={tableScroll}>
            <table style={fixedTable('64rem')}>
              {/* Widths live here rather than on the cells: under
                  `table-layout: fixed` the colgroup is the only thing that
                  sets them, and keeping all eight in one place is what makes
                  it obvious that they still total 100. Sized to the estate's
                  real content -- Score holds two digits, Contributors holds up
                  to three names. */}
              <colgroup>
                {COLUMNS.map(column => (
                  <col key={column.heading} style={{ width: column.width }} />
                ))}
              </colgroup>
              <thead>
                <tr>
                  {COLUMNS.map(column => {
                    const key = column.sort;
                    const active = key !== undefined && sort?.key === key;
                    return (
                      <th
                        key={column.heading}
                        // Announced instead of the arrow, which is decoration
                        // and hidden from a screen reader.
                        aria-sort={key ? ariaSort(sort, key) : undefined}
                        style={{
                          ...headerCell,
                          // The containing block for the caret.
                          position: 'relative',
                          // With no room for a permanent arrow on every
                          // heading, colour is what says where the order comes
                          // from.
                          ...(active ? { color: 'var(--portal-accent)' } : {}),
                        }}
                      >
                        {key ? (
                          <button
                            type="button"
                            onClick={() =>
                              setSort(current => nextSort(current, key))
                            }
                            style={sortButton}
                            title={`Sort by ${column.heading.toLowerCase()}`}
                          >
                            {column.heading}
                          </button>
                        ) : (
                          column.heading
                        )}
                        {active && (
                          <span aria-hidden style={caret}>
                            {sort?.direction === 'asc' ? '▲' : '▼'}
                          </span>
                        )}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {visible.map(repository => (
                  <tr key={repository.entityRef}>
                    <td style={truncatedCell} title={repository.slug}>
                      <Link
                        href={`/catalog/default/component/${repository.slug}`}
                      >
                        {repository.slug}
                      </Link>
                    </td>
                    <td style={{ ...nowrapCell, ...NUMERIC }}>
                      <Text
                        style={
                          repository.score
                            ? { color: bandText(repository.score.band) }
                            : undefined
                        }
                      >
                        {repository.score ? repository.score.total : '—'}
                      </Text>
                    </td>
                    <td style={nowrapCell}>
                      <Text
                        variant="body-small"
                        style={
                          repository.score
                            ? { color: bandText(repository.score.band) }
                            : undefined
                        }
                      >
                        {repository.score
                          ? bandLabel(repository.score.band)
                          : 'Not scored'}
                      </Text>
                    </td>
                    <td style={nowrapCell}>
                      <Text variant="body-small" color="secondary">
                        {timeAgo(repository.lastCommitAt) ?? 'Never'}
                      </Text>
                    </td>
                    <td
                      style={truncatedCell}
                      title={
                        repository.createdBy?.name ??
                        repository.createdBy?.email ??
                        undefined
                      }
                    >
                      {/* Bitbucket records no creator, so this is the author of
                        the earliest commit. Where history was imported that
                        author may never have touched this repository, which is
                        what the asterisk marks -- the repository page explains
                        it in full. */}
                      <Text variant="body-small" color="secondary">
                        {repository.createdBy
                          ? `${
                              repository.createdBy.name ??
                              repository.createdBy.email ??
                              '—'
                            }${
                              repository.createdBy.importedHistory ? ' *' : ''
                            }`
                          : '—'}
                      </Text>
                    </td>
                    <td
                      style={truncatedCell}
                      title={repository.contributors?.join(' · ')}
                    >
                      <Text variant="body-small" color="secondary">
                        {repository.contributors &&
                        repository.contributors.length > 0
                          ? formatContributors(repository.contributors)
                          : '—'}
                      </Text>
                    </td>
                    <td
                      style={truncatedCell}
                      title={
                        repository.proposedOwner?.name ??
                        repository.proposedOwner?.email ??
                        undefined
                      }
                    >
                      {/* Headed "Owner", not "Owner?".
                        The question mark was right when every name here was a
                        guess drawn from commit history and the catalog recorded
                        all 95 repositories as unowned. Since the ownership
                        register landed that is no longer true: 89 of 95 owners
                        are confirmed by a document somebody wrote, and only 6
                        are inferred. Hedging all of them undersells the
                        confirmed ones. The 6 guesses are still marked -- they
                        carry the `unconfirmed-owner` tag, and the repository
                        page says so in words. */}
                      <Text variant="body-small" color="secondary">
                        {repository.proposedOwner
                          ? repository.proposedOwner.name ??
                            repository.proposedOwner.email ??
                            '—'
                          : '—'}
                      </Text>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Flex>
  );
}
