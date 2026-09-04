import { renderInTestApp } from '@backstage/frontend-test-utils';
import { screen } from '@testing-library/react';
import { CommitTrend, bucketLabel, bucketRangeLabel } from './CommitTrend';

const point = (start: string, commits: number) => ({ start, commits });

describe('bucketRangeLabel', () => {
  // The bug this exists to prevent: the tooltip read "3 Aug: 147 commits" on a
  // weekly chart, which states that 147 commits were made on one day. They were
  // spread across the week of 3-9 August.
  it('names both ends of a week rather than only its start', () => {
    expect(bucketRangeLabel('2026-08-03T00:00:00.000Z', 'week')).toBe(
      '3-9 Aug',
    );
  });

  it('repeats the month when a week straddles two of them', () => {
    expect(bucketRangeLabel('2026-08-31T00:00:00.000Z', 'week')).toBe(
      '31 Aug - 6 Sept',
    );
  });

  it('carries the year on a month bucket, which can span a December', () => {
    expect(bucketRangeLabel('2026-08-01T00:00:00.000Z', 'month')).toBe(
      'Aug 2026',
    );
  });

  it('leaves a day bucket alone, where the start already is the period', () => {
    expect(bucketRangeLabel('2026-08-04T00:30:00.000Z', 'day')).toBe('4 Aug');
  });

  it('is empty for an unparseable date, like bucketLabel', () => {
    expect(bucketRangeLabel('not-a-date', 'week')).toBe('');
  });
});

describe('bucketLabel', () => {
  it('names a month by its month alone', () => {
    expect(bucketLabel('2026-08-01T00:00:00.000Z', 'month')).toBe('Aug');
  });

  it('names a day or week by date, since several fall in one month', () => {
    expect(bucketLabel('2026-08-04T00:00:00.000Z', 'week')).toBe('4 Aug');
  });

  it('formats in UTC, not the reader timezone', () => {
    // A local-midnight boundary would shift a bucket into the previous day for
    // anyone west of UTC, so two people would read different charts.
    expect(bucketLabel('2026-08-04T00:30:00.000Z', 'day')).toBe('4 Aug');
  });

  it('returns nothing for an unparseable timestamp', () => {
    expect(bucketLabel('not-a-date', 'week')).toBe('');
  });
});

describe('CommitTrend', () => {
  it('says so plainly when there is nothing to plot', async () => {
    await renderInTestApp(<CommitTrend trend={[]} bucket="week" />);

    expect(
      await screen.findByText('No commits in this period.'),
    ).toBeInTheDocument();
  });

  it('labels the peak so full height means something', async () => {
    await renderInTestApp(
      <CommitTrend
        trend={[
          point('2026-08-01T00:00:00.000Z', 3),
          point('2026-08-08T00:00:00.000Z', 12),
        ]}
        bucket="week"
      />,
    );

    expect(await screen.findByText('peak 12')).toBeInTheDocument();
    expect(screen.getByText('Commits per week')).toBeInTheDocument();
  });

  it('gives every bucket an accessible label, including empty ones', async () => {
    // A zero week is the signal, so it keeps a hairline bar rather than
    // vanishing and leaving an unexplained gap in the run.
    await renderInTestApp(
      <CommitTrend
        trend={[
          point('2026-08-01T00:00:00.000Z', 4),
          point('2026-08-08T00:00:00.000Z', 0),
        ]}
        bucket="week"
      />,
    );

    expect(
      await screen.findByLabelText('1-7 Aug: 4 commits'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('8-14 Aug: 0 commits')).toBeInTheDocument();
  });

  it('names the bucket size it was given', async () => {
    await renderInTestApp(
      <CommitTrend
        trend={[point('2026-08-01T00:00:00.000Z', 1)]}
        bucket="day"
      />,
    );

    expect(await screen.findByText('Commits per day')).toBeInTheDocument();
  });
});
