import type { CSSProperties } from 'react';
import type { FleetRepositorySummary } from '@internal/backstage-plugin-fleet-common';
import { Flex, Text } from '@backstage/ui';
import { BAND_FILL, BAND_LABEL } from '../../bands';
import { bandCounts, technologyCounts, type FleetFilters } from '../../filter';

/** Technology chips shown before the list is truncated. */
const MAX_TECHNOLOGIES = 10;

const chip = (active: boolean): CSSProperties => ({
  appearance: 'none',
  cursor: 'pointer',
  font: 'inherit',
  fontSize: '0.75rem',
  padding: '0.15rem 0.5rem',
  borderRadius: '2px',
  border: `1px solid ${active ? 'var(--bui-fg-primary)' : 'var(--bui-border)'}`,
  background: active ? 'var(--bui-bg-surface-2)' : 'transparent',
  color: 'inherit',
});

export interface FleetFiltersBarProps {
  /** Every repository, before filtering -- the counts describe the whole estate. */
  repositories: FleetRepositorySummary[];
  /** How many rows survive the current filters. */
  visibleCount: number;
  filters: FleetFilters;
  onChange(filters: FleetFilters): void;
}

/**
 * Filters for the fleet.
 *
 * The band bar doubles as the band filter: the most common question is "show
 * me the critical ones", and the segment already showing that count is the
 * obvious thing to click.
 *
 * Built from plain controls rather than the BUI form components, which wrap
 * react-aria selection APIs that would be more machinery than three filters
 * need.
 */
export function FleetFiltersBar({
  repositories,
  visibleCount,
  filters,
  onChange,
}: FleetFiltersBarProps) {
  const counts = bandCounts(repositories);
  const technologies = technologyCounts(repositories);
  const total = repositories.length;

  const segments = [
    { band: 'critical', n: counts.critical },
    { band: 'needs-attention', n: counts.needsAttention },
    { band: 'healthy', n: counts.healthy },
  ].filter(segment => segment.n > 0);

  const toggle = <K extends keyof FleetFilters>(key: K, value: string) =>
    onChange({
      ...filters,
      [key]: filters[key] === value ? undefined : value,
    });

  const filtered = filters.band || filters.technology || filters.query?.trim();

  return (
    <Flex direction="column" gap="3">
      {segments.length > 0 && (
        <div
          style={{
            display: 'flex',
            height: '1.75rem',
            border: '1px solid var(--bui-border)',
            overflow: 'hidden',
          }}
        >
          {segments.map(segment => {
            const active = filters.band === segment.band;
            return (
              <button
                key={segment.band}
                type="button"
                onClick={() => toggle('band', segment.band)}
                aria-pressed={active}
                // A screen reader announcing a bare "2" is useless; label it
                // the same way the other filter chips are labelled.
                aria-label={`${BAND_LABEL[segment.band]} (${segment.n})`}
                title={`${BAND_LABEL[segment.band]} (${segment.n})`}
                style={{
                  flex: segment.n,
                  appearance: 'none',
                  cursor: 'pointer',
                  border: 'none',
                  font: 'inherit',
                  fontSize: '0.75rem',
                  fontWeight: 500,
                  ...BAND_FILL[segment.band],
                  opacity: !filters.band || active ? 1 : 0.45,
                }}
              >
                {segment.n}
              </button>
            );
          })}
        </div>
      )}

      <Flex gap="3" align="center" style={{ flexWrap: 'wrap' }}>
        <input
          type="search"
          value={filters.query ?? ''}
          onChange={event =>
            onChange({ ...filters, query: event.target.value })
          }
          placeholder="Filter repositories"
          aria-label="Filter repositories by name"
          style={{
            font: 'inherit',
            fontSize: '0.8125rem',
            padding: '0.25rem 0.5rem',
            border: '1px solid var(--bui-border)',
            borderRadius: '2px',
            background: 'transparent',
            color: 'inherit',
            minWidth: '14rem',
          }}
        />

        {counts.unscored > 0 && (
          <button
            type="button"
            onClick={() => toggle('band', 'unscored')}
            aria-pressed={filters.band === 'unscored'}
            style={chip(filters.band === 'unscored')}
          >
            Not scored ({counts.unscored})
          </button>
        )}

        {filtered && (
          <button
            type="button"
            onClick={() => onChange({})}
            style={chip(false)}
          >
            Clear filters
          </button>
        )}
      </Flex>

      {technologies.length > 0 && (
        <Flex gap="2" align="center" style={{ flexWrap: 'wrap' }}>
          {technologies.slice(0, MAX_TECHNOLOGIES).map(technology => (
            <button
              key={technology.label}
              type="button"
              onClick={() => toggle('technology', technology.label)}
              aria-pressed={filters.technology === technology.label}
              style={chip(filters.technology === technology.label)}
            >
              {technology.label} ({technology.count})
            </button>
          ))}
        </Flex>
      )}

      <Text variant="body-x-small" color="secondary">
        {filtered
          ? `Showing ${visibleCount} of ${total} repositories`
          : `${total} repositories`}
      </Text>
    </Flex>
  );
}
