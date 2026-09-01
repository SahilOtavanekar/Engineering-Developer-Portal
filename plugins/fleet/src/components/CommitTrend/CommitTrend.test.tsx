import { renderInTestApp } from '@backstage/frontend-test-utils';
import { screen } from '@testing-library/react';
import { CommitTrend, bucketLabel } from './CommitTrend';

const point = (start: string, commits: number) => ({ start, commits });

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
      await screen.findByLabelText('1 Aug: 4 commits'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('8 Aug: 0 commits')).toBeInTheDocument();
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
