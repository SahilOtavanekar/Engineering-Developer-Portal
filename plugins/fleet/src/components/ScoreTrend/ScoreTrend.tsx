import type { ScoreHistoryPoint } from '@internal/backstage-plugin-fleet-common';
import { Flex, Text } from '@backstage/ui';

import { bandText } from '../../bands';

const WIDTH = 96;
const HEIGHT = 24;
const PADDING = 2;

const FLAT = 'var(--bui-fg-secondary)';
/**
 * Rising and falling reuse the band intents; flat stays neutral.
 *
 * Taken from the best and worst bands rather than named tokens, so a change to
 * how a band is coloured carries here too -- a rising trend drawn in a green
 * the rest of the page has stopped using would read as a different signal.
 */
const RISING = bandText('excellent') ?? FLAT;
const FALLING = bandText('at-risk') ?? FLAT;

/** Extracted because a nested ternary reads badly and lint rejects it. */
function trendColour(delta: number): string {
  if (delta > 0) return RISING;
  if (delta < 0) return FALLING;
  return FLAT;
}

export interface ScoreTrendProps {
  /** Oldest first, including the current score. */
  history: ScoreHistoryPoint[];
}

/**
 * Direction of travel between the first and last recorded score.
 *
 * A bare number says whether a repository is good. The trend says whether
 * anyone is doing anything about it, which is the part that changes behaviour.
 */
export function scoreDelta(history: ScoreHistoryPoint[]): number | undefined {
  if (history.length < 2) return undefined;
  return history[history.length - 1].total - history[0].total;
}

/**
 * Maps scores onto an SVG polyline.
 *
 * The vertical scale is fixed to 0-100 rather than fitted to the data: a
 * fitted axis would make a wobble between 71 and 73 look like a collapse.
 */
export function sparklinePoints(
  history: ScoreHistoryPoint[],
  width = WIDTH,
  height = HEIGHT,
): string {
  if (history.length === 0) return '';

  const usableWidth = width - PADDING * 2;
  const usableHeight = height - PADDING * 2;
  const step = history.length > 1 ? usableWidth / (history.length - 1) : 0;

  return history
    .map((point, index) => {
      const clamped = Math.min(100, Math.max(0, point.total));
      const x = PADDING + index * step;
      const y = PADDING + usableHeight - (clamped / 100) * usableHeight;
      return `${Math.round(x * 10) / 10},${Math.round(y * 10) / 10}`;
    })
    .join(' ');
}

export function ScoreTrend({ history }: ScoreTrendProps) {
  // A single run is not a trend; saying so beats drawing a flat line that
  // implies stability nobody has observed.
  if (history.length < 2) {
    return (
      <Text variant="body-x-small" color="secondary">
        No trend yet — one scoring run so far
      </Text>
    );
  }

  const delta = scoreDelta(history) ?? 0;
  const colour = trendColour(delta);
  const sign = delta > 0 ? '+' : '';

  return (
    <Flex gap="3" align="center">
      <svg
        width={WIDTH}
        height={HEIGHT}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label={`Score trend across ${history.length} runs, ${
          delta === 0 ? 'unchanged' : `${sign}${delta} points`
        }`}
        style={{ display: 'block', overflow: 'visible' }}
      >
        <polyline
          points={sparklinePoints(history)}
          fill="none"
          stroke={colour}
          strokeWidth={1.5}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      </svg>
      <Text variant="body-x-small" style={{ color: colour }}>
        {delta === 0 ? 'unchanged' : `${sign}${delta}`} over {history.length}{' '}
        runs
      </Text>
    </Flex>
  );
}
