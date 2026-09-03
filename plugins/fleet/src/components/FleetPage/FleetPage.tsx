import { useMemo, useState } from 'react';
import { useApi, fetchApiRef } from '@backstage/frontend-plugin-api';
import type { FleetOverview } from '@internal/backstage-plugin-fleet-common';
import { Flex, Link, Skeleton, Text } from '@backstage/ui';
import useAsync from 'react-use/esm/useAsync';
import { timeAgo } from '../../format';
import { BAND_LABEL, BAND_TEXT } from '../../bands';
import { filterRepositories, type FleetFilters } from '../../filter';
import { FleetFiltersBar } from './FleetFilters';
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
const COLUMNS: ReadonlyArray<{ heading: string; width: string }> = [
  { heading: 'Repository', width: '23%' },
  { heading: 'Score', width: '6%' },
  { heading: 'Status', width: '11%' },
  { heading: 'Last commit', width: '11%' },
  { heading: 'Created by', width: '14%' },
  { heading: 'Contributors', width: '20%' },
  { heading: 'Owner', width: '15%' },
];

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

  // Memoised so the empty-array fallback does not produce a fresh reference
  // on every render, which would defeat the filter memo below.
  const repositories = useMemo(() => fleet?.repositories ?? [], [fleet]);
  const visible = useMemo(
    () => filterRepositories(repositories, filters),
    [repositories, filters],
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
                  {COLUMNS.map(column => (
                    <th key={column.heading} style={headerCell}>
                      {column.heading}
                    </th>
                  ))}
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
                            ? { color: BAND_TEXT[repository.score.band] }
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
                            ? { color: BAND_TEXT[repository.score.band] }
                            : undefined
                        }
                      >
                        {repository.score
                          ? BAND_LABEL[repository.score.band] ??
                            repository.score.band
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
