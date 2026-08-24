import type { CSSProperties } from 'react';
import { useApi, fetchApiRef } from '@backstage/frontend-plugin-api';
import type { FleetOverview } from '@internal/backstage-plugin-fleet-common';
import { Flex, Link, Skeleton, Text } from '@backstage/ui';
import useAsync from 'react-use/esm/useAsync';
import { timeAgo } from '../../format';
import { BAND_COLOR, BAND_LABEL } from '../../bands';

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

/** Proportional band bar. Widths are shares, so it always fills the row. */
function BandBar({ counts }: { counts: FleetOverview['counts'] }) {
  const segments = [
    { key: 'critical', n: counts.critical },
    { key: 'needs-attention', n: counts.needsAttention },
    { key: 'healthy', n: counts.healthy },
  ].filter(s => s.n > 0);

  const total = segments.reduce((sum, s) => sum + s.n, 0);
  if (total === 0) return null;

  return (
    <div
      style={{
        display: 'flex',
        height: '1.75rem',
        border: '1px solid var(--bui-border, #d2d9e6)',
        overflow: 'hidden',
      }}
    >
      {segments.map(segment => (
        <div
          key={segment.key}
          title={`${segment.n} ${BAND_LABEL[segment.key]}`}
          style={{
            flex: segment.n,
            background: BAND_COLOR[segment.key],
            color: '#fff',
            fontSize: '0.75rem',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {segment.n}
        </div>
      ))}
    </div>
  );
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

  const { counts, nominalWeight } = fleet;

  return (
    <Flex direction="column" gap="5">
      <Flex direction="column" gap="2">
        <BandBar counts={counts} />
        <Text variant="body-x-small" color="secondary">
          {counts.critical} critical &middot; {counts.needsAttention} needs
          attention &middot; {counts.healthy} healthy
          {counts.unscored > 0 ? ` · ${counts.unscored} not yet scored` : ''}
          {' — '}
          {fleet.repositories.length} repositories, scored out of{' '}
          {nominalWeight}
        </Text>
      </Flex>

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
                'Project',
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
            {fleet.repositories.map(repository => (
              <tr key={repository.entityRef}>
                <td style={cell}>
                  <Link href={`/catalog/default/component/${repository.slug}`}>
                    {repository.slug}
                  </Link>
                </td>
                <td style={{ ...cell, fontVariantNumeric: 'tabular-nums' }}>
                  <Text
                    style={
                      repository.score
                        ? { color: BAND_COLOR[repository.score.band] }
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
                        ? { color: BAND_COLOR[repository.score.band] }
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
    </Flex>
  );
}
