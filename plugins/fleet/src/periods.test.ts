import { buildPeriods, findPeriod } from './periods';

/** Mid-August, so "this quarter" is Q3 and "last quarter" is Q2. */
const NOW = new Date('2026-08-27T09:30:00.000Z');

const period = (id: string) => buildPeriods(NOW).find(p => p.id === id)!;

describe('buildPeriods', () => {
  it('offers the five windows requirement 8 asks to filter by', () => {
    expect(buildPeriods(NOW).map(p => p.id)).toEqual([
      'last-90-days',
      'this-month',
      'last-month',
      'this-quarter',
      'last-quarter',
    ]);
  });

  it('starts this month at the first of the month, UTC', () => {
    // Local midnight would shift commits between buckets depending on who is
    // looking at the page.
    expect(period('this-month').since.toISOString()).toBe(
      '2026-08-01T00:00:00.000Z',
    );
    expect(period('this-month').until).toBeUndefined();
  });

  it('bounds last month at the start of this one, exclusively', () => {
    expect(period('last-month').since.toISOString()).toBe(
      '2026-07-01T00:00:00.000Z',
    );
    expect(period('last-month').until?.toISOString()).toBe(
      '2026-08-01T00:00:00.000Z',
    );
  });

  it('starts this quarter at the first month of the quarter', () => {
    // August is in Q3, which begins in July.
    expect(period('this-quarter').since.toISOString()).toBe(
      '2026-07-01T00:00:00.000Z',
    );
  });

  it('bounds last quarter at the start of this one', () => {
    expect(period('last-quarter').since.toISOString()).toBe(
      '2026-04-01T00:00:00.000Z',
    );
    expect(period('last-quarter').until?.toISOString()).toBe(
      '2026-07-01T00:00:00.000Z',
    );
  });

  it('rolls the year backwards in January', () => {
    // The case naive month arithmetic gets wrong.
    const january = buildPeriods(new Date('2026-01-15T00:00:00.000Z'));
    const lastMonth = january.find(p => p.id === 'last-month')!;
    const lastQuarter = january.find(p => p.id === 'last-quarter')!;

    expect(lastMonth.since.toISOString()).toBe('2025-12-01T00:00:00.000Z');
    expect(lastQuarter.since.toISOString()).toBe('2025-10-01T00:00:00.000Z');
    expect(lastQuarter.until?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('puts every month in the quarter it belongs to', () => {
    const quarterStart = (month: string) =>
      buildPeriods(new Date(`2026-${month}-15T00:00:00.000Z`))
        .find(p => p.id === 'this-quarter')!
        .since.toISOString()
        .slice(0, 7);

    expect(['01', '02', '03'].map(quarterStart)).toEqual([
      '2026-01',
      '2026-01',
      '2026-01',
    ]);
    expect(['10', '11', '12'].map(quarterStart)).toEqual([
      '2026-10',
      '2026-10',
      '2026-10',
    ]);
  });

  it('measures the rolling window from the given instant, not from midnight', () => {
    const ninety = period('last-90-days');

    expect(NOW.getTime() - ninety.since.getTime()).toBe(
      90 * 24 * 60 * 60 * 1000,
    );
  });
});

describe('findPeriod', () => {
  it('finds a period by id', () => {
    expect(findPeriod(buildPeriods(NOW), 'this-quarter').id).toBe(
      'this-quarter',
    );
  });

  it('falls back to the default rather than throwing on an unknown id', () => {
    // An unknown id in a URL should show the default view, not an error page.
    expect(findPeriod(buildPeriods(NOW), 'nonsense' as any).id).toBe(
      'last-90-days',
    );
  });
});
