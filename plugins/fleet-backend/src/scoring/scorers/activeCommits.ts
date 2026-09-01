import type { Scorer } from '../types';

export interface ActiveCommitsOptions {
  /** Commits in the window that earn full marks. Defaults to 10. */
  target?: number;
}

/**
 * Is anyone still working on this?
 *
 * Graded against a target rather than scored on raw volume: a repository with
 * 500 commits is not fifty times healthier than one with 10. Merge commits are
 * already excluded upstream, in the activity query.
 */
export function activeCommitsScorer(
  options: ActiveCommitsOptions = {},
): Scorer {
  const target = Math.max(1, options.target ?? 10);

  return {
    id: 'active-commits',
    title: 'Active commits',
    score({ activity, windowDays }) {
      const { commits } = activity;
      return {
        fraction: Math.min(1, commits / target),
        detail:
          commits === 0
            ? `No commits in ${windowDays} days`
            : `${commits} commit${
                commits === 1 ? '' : 's'
              } in ${windowDays} days`,
        // Nothing useful to say to a repository with no commits at all: it is
        // either a scaffold or abandoned, and "commit more" answers neither.
        // The card reports that as dormancy instead.
        remediation:
          commits === 0
            ? undefined
            : `${target} commits in ${windowDays} days earns full marks; this has ${commits}.`,
      };
    },
  };
}
