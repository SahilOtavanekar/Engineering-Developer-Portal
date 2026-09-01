import type { FleetRepositorySummary } from '@internal/backstage-plugin-fleet-common';

export interface FleetFilters {
  /** A score band, or 'unscored'. Undefined means every band. */
  band?: string;
  /** Free text matched against the repository slug and name. */
  query?: string;
  /**
   * Show only repositories carrying a given problem, by metric id.
   *
   * The point of the estate view: "show me the 29 repositories with no README"
   * turns a class of problem into one pass of work rather than 29 visits.
   */
  problem?: string;
}

/**
 * Filtering happens here rather than server-side because the whole estate --
 * 95 repositories -- arrives in a single response. Round-tripping for a filter
 * would be slower than doing it in memory, and would make the counts and the
 * rows disagree while a request was in flight.
 */
export function filterRepositories(
  repositories: FleetRepositorySummary[],
  filters: FleetFilters = {},
): FleetRepositorySummary[] {
  const query = filters.query?.trim().toLowerCase();

  return repositories.filter(repository => {
    if (filters.band) {
      const band = repository.score?.band ?? 'unscored';
      if (band !== filters.band) return false;
    }

    if (filters.problem) {
      const carries = repository.problems?.top.some(
        p => p.id === filters.problem,
      );
      if (!carries) return false;
    }

    if (query) {
      const haystack = `${repository.slug} ${repository.name}`.toLowerCase();
      if (!haystack.includes(query)) return false;
    }

    return true;
  });
}

export interface ProblemCount {
  id: string;
  title: string;
  /** How many repositories carry it. */
  count: number;
  /** Points forfeited across the estate, for ordering ties sensibly. */
  lost: number;
}

/**
 * Problems across the estate, most widespread first.
 *
 * Counted by **repository**, not by points: a lead fixing a class of problem
 * wants to know how many places to visit. Measured on this estate the answer is
 * README on 29 repositories, which is the cheapest real win available and was
 * invisible while every metric sat in one flat list.
 */
export function problemCounts(
  repositories: FleetRepositorySummary[],
): ProblemCount[] {
  const counts = new Map<string, ProblemCount>();

  for (const repository of repositories) {
    for (const problem of repository.problems?.top ?? []) {
      const current = counts.get(problem.id);
      if (current) {
        current.count += 1;
        current.lost += problem.lost;
      } else {
        counts.set(problem.id, {
          id: problem.id,
          title: problem.title,
          count: 1,
          lost: problem.lost,
        });
      }
    }
  }

  return [...counts.values()].sort(
    (a, b) =>
      b.count - a.count || b.lost - a.lost || a.title.localeCompare(b.title),
  );
}

/**
 * How the below-healthy repositories break down by why.
 *
 * Three unrelated populations hide behind one band: 42 of this estate's 59 were
 * never really developed, 6 were active and stopped, 11 are active but
 * underperforming. Reporting them as one number invites 42 pointless
 * conversations.
 */
export function dormancyCounts(repositories: FleetRepositorySummary[]) {
  const of = (kind: string) =>
    repositories.filter(r => r.problems?.dormancy === kind).length;

  return {
    neverStarted: of('never-started'),
    abandoned: of('abandoned'),
    /** Scored, not dormant, but carrying at least one problem. */
    underperforming: repositories.filter(
      r =>
        r.problems &&
        !r.problems.dormancy &&
        r.problems.top.length > 0 &&
        r.score?.band !== 'healthy',
    ).length,
  };
}

/** Band counts for a given set of rows, including the unscored. */
export function bandCounts(repositories: FleetRepositorySummary[]) {
  const of = (band: string) =>
    repositories.filter(r => (r.score?.band ?? 'unscored') === band).length;

  return {
    critical: of('critical'),
    needsAttention: of('needs-attention'),
    healthy: of('healthy'),
    unscored: of('unscored'),
  };
}
