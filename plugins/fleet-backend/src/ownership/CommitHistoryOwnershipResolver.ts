import type { CommitStore } from '../database/CommitStore';
import type {
  OwnershipCandidate,
  OwnershipProposal,
  OwnershipResolver,
} from './types';

export interface CommitHistoryOwnershipResolverOptions {
  commits: CommitStore;
  /** Candidates kept per repository. Defaults to 3. */
  candidateLimit?: number;
  /**
   * Share of window commits the leader needs before a name is proposed, as
   * "at least this much". Defaults to 0.5.
   */
  minimumShare?: number;
  /**
   * Commits the leader needs regardless of share. Defaults to 3.
   *
   * Without this, one commit out of one is a 100% share and would propose an
   * owner on the strength of a single drive-by change.
   */
  minimumCommits?: number;
}

const DEFAULT_CANDIDATE_LIMIT = 3;
const DEFAULT_MINIMUM_SHARE = 0.5;
const DEFAULT_MINIMUM_COMMITS = 3;

/**
 * Proposes an owner from who has been committing.
 *
 * The premise is narrow and worth stating: whoever writes most of a
 * repository's code is usually the person who knows it, which is not the same
 * as the person accountable for it. This produces a name worth confirming, not
 * an answer. That is why nothing here writes to the catalog.
 *
 * Where the evidence is weak -- no clear leader, or a leader with barely any
 * commits -- it proposes nobody. An unowned repository is a known problem; a
 * repository attributed to someone who does not own it is a problem nobody
 * knows about, and it will be believed for exactly as long as it takes to
 * matter.
 */
export class CommitHistoryOwnershipResolver implements OwnershipResolver {
  readonly source = 'commit-history';

  private readonly commits: CommitStore;
  private readonly candidateLimit: number;
  private readonly minimumShare: number;
  private readonly minimumCommits: number;

  constructor(options: CommitHistoryOwnershipResolverOptions) {
    this.commits = options.commits;
    this.candidateLimit = options.candidateLimit ?? DEFAULT_CANDIDATE_LIMIT;
    this.minimumShare = options.minimumShare ?? DEFAULT_MINIMUM_SHARE;
    this.minimumCommits = options.minimumCommits ?? DEFAULT_MINIMUM_COMMITS;
  }

  async resolve(repositoryId: number, since: Date): Promise<OwnershipProposal> {
    const windowDays = Math.max(
      1,
      Math.round((Date.now() - since.getTime()) / 86_400_000),
    );

    const authors = await this.commits.topAuthorsSince(
      repositoryId,
      since,
      this.candidateLimit,
    );
    const windowCommits = await this.commits.attributedCommitsSince(
      repositoryId,
      since,
    );

    const candidates: OwnershipCandidate[] = authors.map(author => ({
      name: author.name,
      email: author.email,
      accountId: author.accountId,
      commits: author.commits,
    }));

    return {
      candidates,
      proposed: this.strongEnough(candidates, windowCommits),
      windowCommits,
      windowDays,
    };
  }

  /**
   * The share is measured against every commit in the window, not against the
   * candidates kept. Measuring against the kept ones would let a repository
   * with fifty contributors propose whoever happened to lead the top three.
   */
  private strongEnough(
    candidates: OwnershipCandidate[],
    windowCommits: number,
  ): OwnershipCandidate | undefined {
    const [leader, runnerUp] = candidates;
    if (!leader || windowCommits <= 0) return undefined;
    if (leader.commits < this.minimumCommits) return undefined;
    if (leader.commits / windowCommits < this.minimumShare) return undefined;

    // A tie is not a leader, at any share. Two people on half the commits each
    // clear a 50% threshold and picking either of them is a coin toss dressed
    // up as a finding.
    if (runnerUp && runnerUp.commits >= leader.commits) return undefined;

    return leader;
  }
}
