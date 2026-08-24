import type { FleetRepositorySummary } from '@internal/backstage-plugin-fleet-common';

export interface FleetFilters {
  /** A score band, or 'unscored'. Undefined means every band. */
  band?: string;
  /** A technology label. Undefined means every technology. */
  technology?: string;
  /** Free text matched against the repository slug and name. */
  query?: string;
}

export interface TechnologyCount {
  label: string;
  count: number;
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

    if (filters.technology) {
      if (!repository.techStack?.includes(filters.technology)) return false;
    }

    if (query) {
      const haystack = `${repository.slug} ${repository.name}`.toLowerCase();
      if (!haystack.includes(query)) return false;
    }

    return true;
  });
}

/**
 * Technologies present across the estate, most common first.
 *
 * Derived from what was actually found rather than a fixed list, so a stack
 * nobody uses never appears as an empty filter.
 */
export function technologyCounts(
  repositories: FleetRepositorySummary[],
): TechnologyCount[] {
  const counts = new Map<string, number>();

  for (const repository of repositories) {
    for (const label of repository.techStack ?? []) {
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
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
