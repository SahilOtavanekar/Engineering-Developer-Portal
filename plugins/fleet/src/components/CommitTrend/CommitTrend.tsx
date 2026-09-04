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

/**
 * The period a bucket actually covers, for the tooltip.
 *
 * **`bucketLabel` names the instant a bucket starts, which on a weekly or
 * monthly chart is not what the bar measures.** The axis can live with that --
 * a tick marking where a period begins is the ordinary convention -- but a
 * tooltip cannot: "3 Aug: 147 commits" states, in as many words, that 147
 * commits were made on the third of August. The real figure was 147 commits
 * across the week of 3 to 9 August, and the peak day inside it was nothing
 * like 147.
 *
 * Weeks start on Monday because `date_trunc('week', ...)` in
 * `ProductivityStore` is Postgres's ISO week, which does. Verified against the
 * stored data rather than assumed: every bucket start for the productivity
 * chart came back a Monday.
 *
 * A month bucket carries its year. That granularity is only chosen for a window
 * over 200 days, which is long enough to span a December.
 */
export function bucketRangeLabel(start: string, bucket: TrendBucket): string {
  const from = new Date(start);
  if (Number.isNaN(from.getTime())) return '';

  if (bucket === 'day') return bucketLabel(start, bucket);

  if (bucket === 'month') {
    return from.toLocaleDateString('en-GB', {
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    });
  }

  // Six days on, not seven: a Monday-to-Sunday week is inclusive at both ends,
  // and adding a whole week would name the following Monday.
  const to = new Date(from.getTime() + 6 * 86_400_000);
  const day = (d: Date) =>
    d.toLocaleDateString('en-GB', { day: 'numeric', timeZone: 'UTC' });
  // The month is stated once when the week sits inside one, and twice when it
  // straddles two -- "31 Aug - 6 Sep" has to name both to be readable at all.
  return from.getUTCMonth() === to.getUTCMonth()
    ? `${day(from)}-${bucketLabel(to.toISOString(), 'week')}`
    : `${bucketLabel(start, 'week')} - ${bucketLabel(
        to.toISOString(),
        'week',
      )}`;
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
          // The range, not the start -- and the singular, because "1 commits"
          // on the quietest bar of a chart about commit volume is the kind of
          // sloppiness a reader notices.
          const label = `${bucketRangeLabel(point.start, bucket)}: ${
            point.commits
          } ${point.commits === 1 ? 'commit' : 'commits'}`;
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
                // The accent for real activity; a hairline in the border
                // colour for an empty bucket, which keeps the gap visible as a
                // gap rather than letting the bar disappear entirely.
                background:
                  point.commits > 0
                    ? 'var(--portal-accent)'
                    : 'var(--bui-border-2)',
                borderRadius: '2px 2px 0 0',
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
