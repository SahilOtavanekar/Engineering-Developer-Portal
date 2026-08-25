import { useMemo, useState, type CSSProperties } from 'react';
import { useApi, fetchApiRef } from '@backstage/frontend-plugin-api';
import type { FleetOverview } from '@internal/backstage-plugin-fleet-common';
import { Flex, Link, Skeleton, Text } from '@backstage/ui';
import useAsync from 'react-use/esm/useAsync';
import { timeAgo } from '../../format';
import { BAND_LABEL, BAND_TEXT } from '../../bands';
import { filterRepositories, type FleetFilters } from '../../filter';
import { FleetFiltersBar } from './FleetFilters';

const cell: CSSProperties = {
  padding: '0.5rem 0.75rem',
  borderBottom: '1px solid var(--bui-border-soft, #e2e7f0)',
  verticalAlign: 'top',
};

function useFleet() {
  const { fetch } = useApi(fetchApiRef);

  return useAsync(async (): Promise<FleetOverview> => {
    const response = await fetch('plugin://fleet/repositories');
    if (!response.ok) {
      throw new Error(
        `Failed to load the fleet: ${response.status} ${response.statusText}`,
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
      <Text color="secondary">Could not load the fleet. {error.message}</Text>
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

  const { nominalWeight } = fleet;

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
        <div style={{ overflowX: 'auto' }}>
          <table
            style={{
              borderCollapse: 'collapse',
              width: '100%',
              minWidth: '44rem',
            }}
          >
            <thead>
              <tr>
                {[
                  'Repository',
                  'Score',
                  'Band',
                  'Measured',
                  'Last commit',
                  'Owner?',
                  'Stack',
                ].map(heading => (
                  <th
                    key={heading}
                    style={{
                      textAlign: 'left',
                      padding: '0.5rem 0.75rem',
                      borderBottom: '1px solid var(--bui-border, #d2d9e6)',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    <Text variant="body-x-small" color="secondary">
                      {heading}
                    </Text>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map(repository => (
                <tr key={repository.entityRef}>
                  <td style={cell}>
                    <Link
                      href={`/catalog/default/component/${repository.slug}`}
                    >
                      {repository.slug}
                    </Link>
                  </td>
                  <td style={{ ...cell, fontVariantNumeric: 'tabular-nums' }}>
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
                  <td style={cell}>
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
                  <td style={{ ...cell, fontVariantNumeric: 'tabular-nums' }}>
                    <Text variant="body-small" color="secondary">
                      {repository.score
                        ? `${repository.score.availableWeight} / ${nominalWeight}`
                        : '—'}
                    </Text>
                  </td>
                  <td style={cell}>
                    <Text variant="body-small" color="secondary">
                      {timeAgo(repository.lastCommitAt) ?? 'Never'}
                    </Text>
                  </td>
                  <td style={cell}>
                    {/* Deliberately headed "Owner?" -- every name in this
                        column is a proposal drawn from commit history, and the
                        catalog still records these repositories as unowned. */}
                    <Text variant="body-small" color="secondary">
                      {repository.proposedOwner
                        ? repository.proposedOwner.name ??
                          repository.proposedOwner.email ??
                          '—'
                        : '—'}
                    </Text>
                  </td>
                  <td style={cell}>
                    <Text variant="body-small" color="secondary">
                      {repository.techStack && repository.techStack.length > 0
                        ? repository.techStack.slice(0, 3).join(' · ')
                        : repository.projectKey ?? '—'}
                    </Text>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Flex>
  );
}
