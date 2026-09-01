/**
 * The reporting windows requirement 8 asks to filter by.
 *
 * Computed here and sent to the API as explicit `since`/`until` dates, rather
 * than sending "quarter" and letting the backend decide when a quarter starts.
 * Two places deciding that is how a dashboard and a report end up disagreeing.
 *
 * All boundaries are UTC. A month that starts at local midnight would shift
 * commits between buckets depending on who is looking.
 */
export type PeriodId =
  | 'last-90-days'
  | 'this-month'
  | 'last-month'
  | 'this-quarter'
  | 'last-quarter';

export interface Period {
  id: PeriodId;
  label: string;
  since: Date;
  /** Absent means "up to now". */
  until?: Date;
}

const utcMonthStart = (year: number, month: number) =>
  new Date(Date.UTC(year, month, 1));

/** 0-based quarter index for a 0-based month. */
const quarterOf = (month: number) => Math.floor(month / 3);

/**
 * Builds every period relative to a given instant.
 *
 * `now` is a parameter rather than read from the clock so the set is testable
 * and so a page that straddles midnight does not silently change its own
 * buckets between renders.
 */
export function buildPeriods(now: Date): Period[] {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const quarter = quarterOf(month);

  const thisMonth = utcMonthStart(year, month);
  const lastMonth = utcMonthStart(year, month - 1);
  const thisQuarter = utcMonthStart(year, quarter * 3);
  const lastQuarter = utcMonthStart(year, quarter * 3 - 3);

  return [
    {
      id: 'last-90-days',
      label: 'Last 90 days',
      since: new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000),
    },
    { id: 'this-month', label: 'This month', since: thisMonth },
    {
      id: 'last-month',
      label: 'Last month',
      since: lastMonth,
      until: thisMonth,
    },
    { id: 'this-quarter', label: 'This quarter', since: thisQuarter },
    {
      id: 'last-quarter',
      label: 'Last quarter',
      since: lastQuarter,
      until: thisQuarter,
    },
  ];
}

export function findPeriod(periods: Period[], id: PeriodId): Period {
  // Falls back to the first rather than throwing: an unknown id in a URL should
  // show the default view, not an error page.
  return periods.find(p => p.id === id) ?? periods[0];
}
