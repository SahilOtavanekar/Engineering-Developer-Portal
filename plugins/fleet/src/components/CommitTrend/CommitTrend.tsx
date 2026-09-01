import type {
  CommitTrendPoint,
  TrendBucket,
} from '@internal/backstage-plugin-fleet-common';
import { Flex, Text } from '@backstage/ui';

const HEIGHT = 44;
const MIN_BAR = 2;

const BUCKET_LABEL: Record<TrendBucket, string> = {
  day: 'day',
  week: 'week',
  month: 'month',
};

/** Bucket start as a short axis label: "4 Aug", "Jun". */
export function bucketLabel(start: string, bucket: TrendBucket): string {
  const date = new Date(start);
  if (Number.isNaN(date.getTime())) return '';
  if (bucket === 'month') {
    return date.toLocaleDateString('en-GB', {
      month: 'short',
      timeZone: 'UTC',
    });
  }
  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

export interface CommitTrendProps {
  /** Oldest bucket first. */
  trend: CommitTrendPoint[];
  bucket: TrendBucket;
}

/**
 * Commits per bucket, as bars.
 *
 * Bars rather than the line `ScoreTrend` uses, for two reasons. A score is a
 * continuous quantity sampled over time, so joining the samples is honest; a
 * commit count is a discrete total for a closed period, and a line between two
 * of them draws values that were never measured. And `ScoreTrend` fixes its
 * vertical scale to 0-100, which is right for a score out of 100 and
 * meaningless for an unbounded count.
 *
 * The scale here is fitted to the tallest bar and the peak is labelled, so the
 * reader is never left guessing what full height means.
 */
export function CommitTrend({ trend, bucket }: CommitTrendProps) {
  if (trend.length === 0) {
    return (
      <Text variant="body-x-small" color="secondary">
        No commits in this period.
      </Text>
    );
  }

  const peak = Math.max(...trend.map(point => point.commits), 1);
  // Every bucket is labelled when there are few; otherwise only the ends, so
  // the labels never collide.
  const sparse = trend.length > 8;

  return (
    <Flex direction="column" gap="2">
      <Flex gap="2" align="baseline" style={{ flexWrap: 'wrap' }}>
        <Text variant="body-x-small" color="secondary">
          Commits per {BUCKET_LABEL[bucket]}
        </Text>
        <Text variant="body-x-small" color="secondary">
          peak {peak}
        </Text>
      </Flex>

      <div
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          gap: '2px',
          height: `${HEIGHT}px`,
        }}
      >
        {trend.map(point => {
          const label = `${bucketLabel(point.start, bucket)}: ${
            point.commits
          } commits`;
          return (
            <div
              key={point.start}
              title={label}
              aria-label={label}
              role="img"
              style={{
                flex: '1 1 0',
                minWidth: '3px',
                // A zero bucket keeps a hairline rather than vanishing: a gap
                // in the run of bars is the signal, and an absent bar would
                // read as an absent week.
                height: `${Math.max(
                  MIN_BAR,
                  Math.round((point.commits / peak) * HEIGHT),
                )}px`,
                background:
                  point.commits > 0
                    ? 'var(--bui-fg-primary)'
                    : 'var(--bui-border)',
                borderRadius: '1px',
              }}
            />
          );
        })}
      </div>

      <Flex
        gap="2"
        align="center"
        style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}
      >
        <Text variant="body-x-small" color="secondary">
          {bucketLabel(trend[0].start, bucket)}
        </Text>
        {!sparse && trend.length > 2 && (
          <Text variant="body-x-small" color="secondary">
            {trend.length} {BUCKET_LABEL[bucket]}s
          </Text>
        )}
        <Text variant="body-x-small" color="secondary">
          {bucketLabel(trend[trend.length - 1].start, bucket)}
        </Text>
      </Flex>
    </Flex>
  );
}
