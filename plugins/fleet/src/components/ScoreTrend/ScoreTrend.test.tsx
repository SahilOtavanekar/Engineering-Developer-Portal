import { renderInTestApp } from '@backstage/frontend-test-utils';
import { screen } from '@testing-library/react';
import type { ScoreHistoryPoint } from '@internal/backstage-plugin-fleet-common';
import { ScoreTrend, scoreDelta, sparklinePoints } from './ScoreTrend';

const at = (day: number, total: number): ScoreHistoryPoint => ({
  total,
  computedAt: new Date(Date.UTC(2026, 7, day)).toISOString(),
});

describe('scoreDelta', () => {
  it('has no opinion on a single run', () => {
    expect(scoreDelta([at(1, 50)])).toBeUndefined();
  });

  it('has no opinion on no runs at all', () => {
    expect(scoreDelta([])).toBeUndefined();
  });

  it('measures from the oldest to the newest run', () => {
    expect(scoreDelta([at(1, 40), at(2, 55), at(3, 70)])).toBe(30);
  });

  it('reports a decline as negative', () => {
    expect(scoreDelta([at(1, 80), at(2, 60)])).toBe(-20);
  });

  it('reports no movement as zero', () => {
    expect(scoreDelta([at(1, 70), at(2, 70)])).toBe(0);
  });
});

describe('sparklinePoints', () => {
  it('produces nothing for an empty history', () => {
    expect(sparklinePoints([])).toBe('');
  });

  it('scales against a fixed 0-100 axis, not the data range', () => {
    // A fitted axis would make 71 vs 73 look like a collapse. Both points
    // should sit near the top of the box.
    const points = sparklinePoints([at(1, 71), at(2, 73)], 100, 20)
      .split(' ')
      .map(p => Number(p.split(',')[1]));

    expect(points[0]).toBeLessThan(8);
    expect(points[1]).toBeLessThan(8);
    expect(Math.abs(points[0] - points[1])).toBeLessThan(1);
  });

  it('puts a zero score at the bottom and a hundred at the top', () => {
    const [low, high] = sparklinePoints([at(1, 0), at(2, 100)], 100, 20)
      .split(' ')
      .map(p => Number(p.split(',')[1]));

    expect(low).toBeGreaterThan(high);
  });

  it('spreads points evenly across the width', () => {
    const xs = sparklinePoints([at(1, 10), at(2, 20), at(3, 30)], 100, 20)
      .split(' ')
      .map(p => Number(p.split(',')[0]));

    expect(xs[0]).toBeLessThan(xs[1]);
    expect(xs[1]).toBeLessThan(xs[2]);
    expect(xs[2] - xs[1]).toBeCloseTo(xs[1] - xs[0], 1);
  });

  it('clamps a score outside the expected range', () => {
    expect(() =>
      sparklinePoints([at(1, -5), at(2, 150)], 100, 20),
    ).not.toThrow();
  });
});

describe('ScoreTrend', () => {
  it('declines to imply a trend from a single run', async () => {
    await renderInTestApp(<ScoreTrend history={[at(1, 70)]} />);

    expect(
      await screen.findByText(/No trend yet — one scoring run so far/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('reports an improvement with a sign', async () => {
    await renderInTestApp(
      <ScoreTrend history={[at(1, 40), at(2, 55), at(3, 70)]} />,
    );

    expect(await screen.findByText(/\+30 over 3 runs/)).toBeInTheDocument();
  });

  it('reports a decline', async () => {
    await renderInTestApp(<ScoreTrend history={[at(1, 80), at(2, 60)]} />);

    expect(await screen.findByText(/-20 over 2 runs/)).toBeInTheDocument();
  });

  it('says "unchanged" rather than "+0"', async () => {
    await renderInTestApp(<ScoreTrend history={[at(1, 70), at(2, 70)]} />);

    expect(
      await screen.findByText(/unchanged over 2 runs/),
    ).toBeInTheDocument();
  });

  it('describes the trend for screen readers', async () => {
    await renderInTestApp(<ScoreTrend history={[at(1, 40), at(2, 70)]} />);

    expect(
      await screen.findByRole('img', {
        name: 'Score trend across 2 runs, +30 points',
      }),
    ).toBeInTheDocument();
  });
});
