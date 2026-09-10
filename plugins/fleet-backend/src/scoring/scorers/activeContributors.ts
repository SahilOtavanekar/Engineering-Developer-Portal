import type { Scorer } from '../types';

export interface ActiveContributorsOptions {
  /** Distinct authors in the window that earn full marks. Defaults to 2. */
  target?: number;
}

/**
 * **NOT REGISTERED.** Dropped from the scorecard on 2026-09-09 at the product
 * owner's direction: the specification's seven rules do not include it. Kept
 * rather than deleted -- it works and it is tested. Reinstate by adding it to
 * the `scorers` array in `plugin.ts`; `activity.authors` is still populated.
 *
 * How many people can safely change this?
 *
 * A single-author repository is a bus-factor risk even when it is busy, which
 * is why the default target is two rather than one.
 */
export function activeContributorsScorer(
  options: ActiveContributorsOptions = {},
): Scorer {
  const target = Math.max(1, options.target ?? 2);

  return {
    id: 'active-contributors',
    title: 'Active contributors',
    score({ activity, windowDays }) {
      const { authors } = activity;
      return {
        fraction: Math.min(1, authors / target),
        remediation:
          authors === 0
            ? undefined
            : `${target} contributors in ${windowDays} days earns full marks; this has ${authors}. A repository only one person touches is a risk whatever its commit count.`,
        detail:
          authors === 0
            ? `No contributors in ${windowDays} days`
            : `${authors} contributor${
                authors === 1 ? '' : 's'
              } in ${windowDays} days`,
      };
    },
  };
}
