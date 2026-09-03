import type { FleetRepositorySummary } from '@internal/backstage-plugin-fleet-common';
import { Flex, Text } from '@backstage/ui';
import SearchIcon from '@material-ui/icons/Search';
import { BAND_FILL, BAND_LABEL } from '../../bands';
import {
  bandCounts,
  dormancyCounts,
  problemCounts,
  type FleetFilters,
} from '../../filter';
import { chip, input } from '../../surfaces';

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
  const problems = problemCounts(repositories);
  const dormancy = dormancyCounts(repositories);
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

  const filtered = filters.band || filters.problem || filters.query?.trim();

  return (
    <Flex direction="column" gap="3">
      {segments.length > 0 && (
        <div
          style={{
            display: 'flex',
            height: '1.75rem',
            // A pill, and `overflow: hidden` is what clips the three coloured
            // segments to it -- without it they square off the ends.
            borderRadius: 'var(--portal-radius-pill)',
            overflow: 'hidden',
            boxShadow: 'var(--portal-shadow-soft)',
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

      {problems.length > 0 && (
        <Flex direction="column" gap="2">
          <Text variant="body-x-small" color="secondary">
            Most common problems — click to see who has them
            {dormancy.neverStarted + dormancy.abandoned > 0 &&
              `. Separately, ${dormancy.abandoned} repositories were abandoned and ${dormancy.neverStarted} were never really developed.`}
          </Text>
          <Flex gap="3" align="center" style={{ flexWrap: 'wrap' }}>
            {problems.map(problem => (
              <button
                key={problem.id}
                type="button"
                onClick={() =>
                  onChange({
                    ...filters,
                    problem:
                      filters.problem === problem.id ? undefined : problem.id,
                  })
                }
                aria-pressed={filters.problem === problem.id}
                title={`${problem.count} repositories, ${Math.round(
                  problem.lost,
                )} points forfeited across the estate`}
                style={chip(filters.problem === problem.id)}
              >
                {problem.title} ({problem.count})
              </button>
            ))}
          </Flex>
        </Flex>
      )}

      <Flex gap="3" align="center" style={{ flexWrap: 'wrap' }}>
        {/* The sizing lives on the wrapper so the icon can be positioned
            over the input's left padding. */}
        <div
          style={{
            position: 'relative',
            display: 'flex',
            alignItems: 'center',
            // Grows into the row it shares with the remaining chips, but is
            // capped so it does not swallow a wide screen on its own.
            flex: '1 1 22rem',
            maxWidth: '34rem',
          }}
        >
          <SearchIcon
            // Decorative: the input already carries the accessible name, and
            // `pointerEvents: none` keeps a click on the icon landing in the
            // field rather than doing nothing.
            aria-hidden
            style={{
              position: 'absolute',
              left: '0.55rem',
              fontSize: '1.15rem',
              opacity: 0.55,
              pointerEvents: 'none',
            }}
          />
          <input
            type="search"
            value={filters.query ?? ''}
            onChange={event =>
              onChange({ ...filters, query: event.target.value })
            }
            placeholder="Filter repositories"
            aria-label="Filter repositories by name"
            style={input}
          />
        </div>

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

      <Text variant="body-medium" color="secondary">
        {filtered
          ? `Showing ${visibleCount} of ${total} repositories`
          : `${total} repositories`}
      </Text>
    </Flex>
  );
}
