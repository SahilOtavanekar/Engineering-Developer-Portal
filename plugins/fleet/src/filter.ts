import {
  canonicalBand,
  isSatisfactoryBand,
  type FleetRepositorySummary,
} from '@internal/backstage-plugin-fleet-common';

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
  /**
   * Show only repositories this person owns, by `ownerKey`. Any listed owner
   * matches, not only the one the Owner column shows.
   *
   * Stands in for "Owned by me" until sign-in knows who "me" is: everyone
   * signs in as the shared guest, who owns nothing. Once Entra ID provides a
   * real identity, the same filter can be pre-set to the signed-in person.
   */
  owner?: string;
}

type Owner = { name?: string; email?: string };

/**
 * Who an owner is, for matching: the address when there is one, else the name.
 *
 * Not the name alone, because one person reaches here under several spellings:
 * the register says "Gurudutt" and Bitbucket's admin listing "Gurudutt .", for
 * the same gurudutt@demandai.co. Keyed by name, the dropdown offered him twice
 * and each entry found only some of his repositories.
 */
export function ownerKey(owner: Owner): string | undefined {
  const email = owner.email?.trim().toLowerCase();
  if (email) return email;
  const name = owner.name?.trim();
  return name ? `name:${name}` : undefined;
}

/**
 * Everyone who owns a repository, the shown owner first. Falls back to the
 * proposed owner for a response from a backend that predates `owners`.
 */
function listedOwners(repository: FleetRepositorySummary): Owner[] {
  return (
    repository.owners ??
    (repository.proposedOwner ? [repository.proposedOwner] : [])
  );
}

/** The `ownerKey` of everyone who owns a repository, the shown owner first. */
export function ownersOf(repository: FleetRepositorySummary): string[] {
  return listedOwners(repository).flatMap(owner => {
    const key = ownerKey(owner);
    return key ? [key] : [];
  });
}

export interface OwnerOption {
  /** What `FleetFilters.owner` holds when this option is chosen. */
  key: string;
  /** The person's most common spelling across the estate. */
  name: string;
  /** How many repositories they own, counting shared ownership for each owner. */
  count: number;
}

/** Every owner on the estate, one entry per person, for the Owner dropdown. */
export function ownerOptions(
  repositories: FleetRepositorySummary[],
): OwnerOption[] {
  const people = new Map<
    string,
    { count: number; spellings: Map<string, number> }
  >();
  for (const repository of repositories) {
    const seen = new Set<string>();
    for (const owner of listedOwners(repository)) {
      const key = ownerKey(owner);
      const name = owner.name?.trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const person = people.get(key) ?? { count: 0, spellings: new Map() };
      person.count += 1;
      if (name)
        person.spellings.set(name, (person.spellings.get(name) ?? 0) + 1);
      people.set(key, person);
    }
  }
  return [...people]
    .map(([key, { count, spellings }]) => ({
      key,
      // Most used spelling; on a tie the shorter, which drops trailing
      // punctuation like "Gurudutt ." in favour of "Gurudutt".
      name:
        [...spellings].sort(
          ([a, an], [b, bn]) => bn - an || a.length - b.length,
        )[0]?.[0] ?? key,
      count,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
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
      // Canonical on both sides: a segment is built from the current name and
      // a score row may still hold the name it was written under.
      const band = canonicalBand(repository.score?.band) ?? 'unscored';
      if (band !== canonicalBand(filters.band)) return false;
    }

    if (filters.problem) {
      const carries = repository.problems?.top.some(
        p => p.id === filters.problem,
      );
      if (!carries) return false;
    }

    if (filters.owner && !ownersOf(repository).includes(filters.owner)) {
      return false;
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
        // Not `!== 'healthy'`: with Excellent above Healthy that counted the
        // best repositories on the estate as underperforming.
        !isSatisfactoryBand(r.score?.band),
    ).length,
  };
}

/** Band counts for a given set of rows, including the unscored. */
export function bandCounts(repositories: FleetRepositorySummary[]) {
  const of = (band: string) =>
    repositories.filter(
      r => (canonicalBand(r.score?.band) ?? 'unscored') === band,
    ).length;

  return {
    atRisk: of('at-risk'),
    needsAttention: of('needs-attention'),
    healthy: of('healthy'),
    excellent: of('excellent'),
    unscored: of('unscored'),
  };
}
