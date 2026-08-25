import type { BitbucketClient } from '../bitbucket/types';
import type { CommitStore } from '../database/CommitStore';
import type { RepositoryStore } from '../database/RepositoryStore';
import { AuthorIndex } from './identity';
import type {
  OwnershipCandidate,
  OwnershipProposal,
  OwnershipResolver,
} from './types';

export interface PermissionOwnershipResolverOptions {
  client: BitbucketClient;
  commits: CommitStore;
  repositories: RepositoryStore;
}

const ADMIN = 'admin';

/**
 * Proposes the person Bitbucket says is accountable, not the busiest committer.
 *
 * Repository admin permission is the closest thing in Bitbucket to a declared
 * owner, and it disagrees with commit history far more often than not: across
 * this estate the busiest committer and the admin differ in **18 of the 26
 * repositories where both are known**. `oxp-backend` is the clearest case --
 * Brijesh Gupta wrote 187 of its last 214 commits, and the admins are
 * Sreenivas Dasam and Avinash More.
 *
 * Coverage is also far better: **78 of 95 repositories have at least one
 * admin**, against 22 with a clear majority committer.
 *
 * Where several people hold admin, commit history breaks the tie -- the
 * accountable person who is also doing the work. Where nobody holds admin
 * this proposes nothing and leaves the fallback to
 * {@link CompositeOwnershipResolver}.
 *
 * Costs one request per repository. The workspace-wide endpoint would answer
 * for the whole estate at once but returns 403 for this credential.
 */
export class PermissionOwnershipResolver implements OwnershipResolver {
  readonly source = 'repository-admin';

  private readonly client: BitbucketClient;
  private readonly commits: CommitStore;
  private readonly repositories: RepositoryStore;
  private authors = new AuthorIndex();

  constructor(options: PermissionOwnershipResolverOptions) {
    this.client = options.client;
    this.commits = options.commits;
    this.repositories = options.repositories;
  }

  /**
   * Builds the name-to-email index once, rather than 95 times.
   *
   * Permissions name people but carry no email, and the catalog keys a User
   * entity on one. See {@link AuthorIndex} for why this is a join on names and
   * what that costs.
   */
  async prepare(workspace: string): Promise<void> {
    this.authors = new AuthorIndex(
      await this.commits.distinctAuthors(workspace),
    );
  }

  async resolve(
    repositoryId: number,
    since: Date,
    windowDays: number,
  ): Promise<OwnershipProposal> {
    const record = await this.repositories.findById(repositoryId);
    if (!record) {
      return { candidates: [], windowCommits: 0, windowDays };
    }

    const permissions = await this.client.listRepositoryPermissions(
      record.workspace,
      record.slug,
    );
    const admins = permissions.filter(entry => entry.permission === ADMIN);

    const windowCommits = await this.commits.attributedCommitsSince(
      repositoryId,
      since,
    );

    if (admins.length === 0) {
      // Not "nobody owns this" -- "Bitbucket was not told". The composite
      // resolver falls back to commit history for these 17 repositories.
      return { candidates: [], windowCommits, windowDays };
    }

    // Commit counts are only needed to break a tie between admins, so they are
    // fetched only when there is a tie to break.
    const contributions =
      admins.length > 1
        ? await this.commits.topAuthorsSince(repositoryId, since, 50)
        : [];
    const commitsByEmail = new Map(
      contributions.map(entry => [entry.email, entry.commits]),
    );

    const candidates: OwnershipCandidate[] = admins.map(admin => {
      const email = this.authors.emailFor(admin.displayName);
      return {
        name: admin.displayName,
        email,
        accountId: admin.accountId,
        commits: (email && commitsByEmail.get(email)) || 0,
      };
    });

    // Busiest admin first, so rank 1 is the tie-break winner and the stored
    // ranking reads the way a person would order it.
    candidates.sort((a, b) => b.commits - a.commits || 0);

    return {
      candidates,
      proposed: this.pick(candidates),
      windowCommits,
      windowDays,
    };
  }

  /**
   * Which admin, if any, to actually put forward.
   *
   * A sole admin is proposed whether or not they have committed: accountability
   * does not lapse because somebody stopped typing. Where several hold admin,
   * the one doing the work is the better guess -- but if none of them has
   * committed there is nothing to choose between them, and naming one would be
   * a coin toss dressed as a finding.
   */
  private pick(
    candidates: OwnershipCandidate[],
  ): OwnershipCandidate | undefined {
    const [leader] = candidates;
    if (!leader) return undefined;
    if (candidates.length === 1) return leader;
    return leader.commits > 0 ? leader : undefined;
  }
}
