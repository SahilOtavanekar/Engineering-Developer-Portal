import type { CommitStore } from '../database/CommitStore';
import type { RepositoryStore } from '../database/RepositoryStore';
import {
  EMPTY_OWNERSHIP_REGISTER,
  type OwnershipRegister,
} from './ownershipRegister';
import {
  OWNERSHIP_SOURCE_REGISTER,
  type OwnershipCandidate,
  type OwnershipProposal,
  type OwnershipResolver,
} from './types';

export interface RegisterOwnershipResolverOptions {
  register?: OwnershipRegister;
  repositories: RepositoryStore;
  commits: CommitStore;
}

/**
 * Reports the owner somebody has actually confirmed.
 *
 * Every other resolver infers: admin permission asks Bitbucket who holds a
 * setting, commit history asks who types most. Both were measured against the
 * repository standardization document and neither is better than a guess three
 * times in four -- **admin permission agreed with it on 47 of 62 repositories
 * (76%) and commit history on 7 of 9 (78%)**. They are not the authority they
 * were taken for; the earlier conclusion that admin permission "beats commit
 * history, and it is not close" compared the two against each other with
 * nothing to check either against.
 *
 * `oxp-backend` is the case that settles it. Commit history said Brijesh Gupta,
 * who wrote 187 of its last 214 commits; admin permission said Avinash More;
 * the document says the owners are Brijesh, Sanjay and Vivek. The inference we
 * chose to trust was the wrong one.
 *
 * So this resolver goes first, and unlike the others its answers are
 * **confirmed** rather than proposed: they carry no `unconfirmed-owner` tag and
 * the evidence annotation says a person confirmed them. A repository absent
 * from the register falls through to the derived resolvers unchanged, and is
 * still reported as a guess.
 *
 * Costs no Bitbucket requests at all.
 */
export class RegisterOwnershipResolver implements OwnershipResolver {
  readonly source = OWNERSHIP_SOURCE_REGISTER;

  private readonly register: OwnershipRegister;
  private readonly repositories: RepositoryStore;
  private readonly commits: CommitStore;

  constructor(options: RegisterOwnershipResolverOptions) {
    this.register = options.register ?? EMPTY_OWNERSHIP_REGISTER;
    this.repositories = options.repositories;
    this.commits = options.commits;
  }

  /** How many repositories the register can answer for, for startup logging. */
  get size(): number {
    return this.register.repositories.size;
  }

  async resolve(
    repositoryId: number,
    since: Date,
    windowDays: number,
  ): Promise<OwnershipProposal> {
    const empty: OwnershipProposal = {
      candidates: [],
      windowCommits: 0,
      windowDays,
    };
    if (this.register.repositories.size === 0) return empty;

    const record = await this.repositories.findById(repositoryId);
    if (!record) return empty;

    const owners = this.register.repositories.get(record.slug);
    if (!owners?.length) return empty;

    const windowCommits = await this.commits.attributedCommitsSince(
      repositoryId,
      since,
    );

    // Commit counts are shown alongside a confirmed owner, never used to rank
    // one: the register's order is the answer, and an owner who has not
    // committed lately is still the owner.
    const contributions = await this.commits.topAuthorsSince(
      repositoryId,
      since,
      50,
    );
    const commitsByEmail = new Map(
      contributions.map(entry => [entry.email, entry.commits]),
    );

    const candidates: OwnershipCandidate[] = owners.map(key => {
      const person = this.register.people.get(key)!;
      return {
        name: person.name,
        email: person.email,
        commits: commitsByEmail.get(person.email) ?? 0,
      };
    });

    return {
      candidates,
      // Always proposed. There is no confidence threshold to clear: a person
      // wrote this down, which is the thing every other resolver is trying to
      // approximate.
      proposed: candidates[0],
      windowCommits,
      windowDays,
    };
  }
}
