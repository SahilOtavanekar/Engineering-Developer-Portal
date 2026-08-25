/** One person who might own a repository, and the evidence for it. */
export interface OwnershipCandidate {
  name?: string;
  email?: string;
  accountId?: string;
  /** Commits attributed to this person within the window. */
  commits: number;
}

/**
 * What one resolver concluded about a repository.
 *
 * `proposed` is deliberately separate from `candidates[0]`: the strongest
 * candidate is a fact, whether it is strong enough to put a name to is a
 * policy, and a caller that wants the raw ranking should not have to reverse
 * that policy out of the list.
 */
export interface OwnershipProposal {
  /** Strongest first. Empty when there is no commit history to work from. */
  candidates: OwnershipCandidate[];
  /** Absent when no candidate is clearly enough ahead to name. */
  proposed?: OwnershipCandidate;
  /** Commits considered, so a share can be shown honestly. */
  windowCommits: number;
  windowDays: number;
}

/**
 * Where ownership comes from.
 *
 * An interface with one implementation today, on purpose. The eventual source
 * of record is Microsoft Entra via msgraph, which is deferred to the end of the
 * build; commit history is a stand-in that produces something confirmable in
 * the meantime. When Entra lands it becomes a second implementation and the
 * callers do not change.
 *
 * Note what this does *not* do: write to the catalog. Confirmed ownership lives
 * on `spec.owner`, and a derived guess placed there would read as authoritative
 * everywhere in Backstage.
 */
export interface OwnershipResolver {
  /** A label for logs and for showing people where a proposal came from. */
  readonly source: string;

  resolve(repositoryId: number, since: Date): Promise<OwnershipProposal>;
}
