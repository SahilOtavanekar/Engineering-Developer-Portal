/** How a commit reached the default branch. */
export type CommitArrival =
  /** Produced by a pull request merged into this branch. */
  | 'pull-request'
  /** Committed straight onto the branch. */
  | 'direct'
  /** A merge onto the branch with no pull request behind it. */
  | 'direct-merge'
  /** Reached the branch as part of a merge, not on its own. */
  | 'merged-in'
  /**
   * The commit the branch began with. Pushed by necessity -- a pull request
   * needs a branch to merge into, and an empty repository has none -- so it
   * is neither a pull request nor a bypass of one, and is judged as neither.
   */
  | 'initial';

export interface CommitNode {
  hash: string;
  /** First parent first. Empty for a root commit. */
  parents: string[];
}

export interface ClassifiedCommit {
  hash: string;
  onMainline: boolean;
  arrival: CommitArrival;
}

/**
 * Bitbucket abbreviates a pull request's `merge_commit.hash` to 12 characters
 * while commit hashes are full 40-character SHAs, so this compares by prefix in
 * whichever direction is shorter.
 *
 * Matching them as whole strings finds nothing at all, which does not fail --
 * it reports every commit as direct. That looked entirely plausible on a real
 * estate and took an independent check against Bitbucket to catch.
 */
function sameCommit(a: string, b: string): boolean {
  return a.startsWith(b) || b.startsWith(a);
}

export interface ClassifyOptions {
  /** Newest first, as Bitbucket lists them. */
  commits: CommitNode[];
  /** `merge_commit_hash` of pull requests merged **into this branch**. */
  pullRequestMerges: string[];
  /**
   * Only classify commits at or after this point.
   *
   * The walk still needs older commits present in `commits` to follow the
   * chain, so this bounds what is *reported*, not what is read.
   */
  since?: (hash: string) => boolean;
}

/**
 * Works out which commits were made on the default branch and which a merge
 * brought in.
 *
 * The first-parent chain from the branch tip is the branch's own history: at a
 * merge, the first parent is where the branch already was and the second is
 * what was merged into it. So everything reachable by following first parents
 * is *on* the branch, and everything else arrived as part of a merge.
 *
 * That distinction is the whole measurement. On this estate 1,168 of 1,753
 * commits on default branches in 90 days were merged in rather than made there,
 * so a rule that skipped the walk and looked at every commit would overstate
 * direct commits threefold.
 *
 * A mainline commit is then judged by whether a pull request produced it:
 *
 * - matches a pull request merge  -> `pull-request` (covers squash and merge
 *   commits alike, which matters because both are in use here -- a squashed
 *   pull request lands as a single-parent commit indistinguishable by shape
 *   from a direct one)
 * - otherwise, two or more parents -> `direct-merge`, someone merged locally
 *   and pushed, or pulled with a merge
 * - otherwise, no parents at all   -> `initial`, where the branch began
 * - otherwise                      -> `direct`
 *
 * **The initial commit is its own arrival, not a direct one.** It used to fall
 * through to `direct`, which cost every new repository the whole pull-request
 * metric for its first 30 days for a push nobody could have avoided: measured
 * 2026-10-08, 7 repositories, and in every one of them it was the only commit
 * against them. Only the mainline root qualifies -- a root a merge brought in
 * stays `merged-in`, and a commit whose parent merely is not stored has
 * parents, so it stays `direct`.
 */
export function classifyArrivals(options: ClassifyOptions): ClassifiedCommit[] {
  const { commits, pullRequestMerges, since } = options;
  if (commits.length === 0) return [];

  const byHash = new Map(commits.map(commit => [commit.hash, commit]));

  // Walk first parents from the tip. Guarded against a cycle in malformed
  // input rather than trusting the graph to be acyclic.
  const mainline = new Set<string>();
  let cursor: CommitNode | undefined = commits[0];
  while (cursor && !mainline.has(cursor.hash)) {
    mainline.add(cursor.hash);
    // Annotated because inferring it from `byHash.get` below makes the
    // assignment to `cursor` self-referential.
    const first: string | undefined = cursor.parents[0];
    cursor = first ? byHash.get(first) : undefined;
  }

  const merged = (hash: string) =>
    pullRequestMerges.some(candidate => sameCommit(hash, candidate));

  return commits
    .filter(commit => !since || since(commit.hash))
    .map(commit => {
      if (!mainline.has(commit.hash)) {
        return {
          hash: commit.hash,
          onMainline: false,
          arrival: 'merged-in' as const,
        };
      }
      if (merged(commit.hash)) {
        return {
          hash: commit.hash,
          onMainline: true,
          arrival: 'pull-request' as const,
        };
      }
      let arrival: CommitArrival = 'direct';
      if (commit.parents.length >= 2) arrival = 'direct-merge';
      else if (commit.parents.length === 0) arrival = 'initial';
      return { hash: commit.hash, onMainline: true, arrival };
    });
}

/** Counts for one repository over a window. */
export interface BranchPolicySummary {
  /**
   * Commits on the branch's own history that are judged: everything except
   * the initial commit, which is counted separately.
   */
  mainline: number;
  viaPullRequest: number;
  direct: number;
  directMerge: number;
  /** Reached the branch inside a merge. Reported so the total reconciles. */
  mergedIn: number;
  /**
   * The commit the branch began with, if it falls in the window: 0 or 1.
   * Outside `mainline`, so it is neither credited nor held against anyone.
   */
  initial: number;
}

export function summarise(classified: ClassifiedCommit[]): BranchPolicySummary {
  const count = (arrival: CommitArrival) =>
    classified.filter(commit => commit.arrival === arrival).length;

  const viaPullRequest = count('pull-request');
  const direct = count('direct');
  const directMerge = count('direct-merge');

  return {
    mainline: viaPullRequest + direct + directMerge,
    viaPullRequest,
    direct,
    directMerge,
    mergedIn: count('merged-in'),
    initial: count('initial'),
  };
}

/** Direct commits of either kind. */
export function directTotal(summary: BranchPolicySummary): number {
  return summary.direct + summary.directMerge;
}
