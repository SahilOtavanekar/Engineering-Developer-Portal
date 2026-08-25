import type { LoggerService } from '@backstage/backend-plugin-api';
import type { OwnershipProposal, OwnershipResolver } from './types';

export interface CompositeOwnershipResolverOptions {
  /** Tried in order. The first to name somebody wins. */
  resolvers: OwnershipResolver[];
  logger?: LoggerService;
}

/**
 * Tries several sources in order of authority.
 *
 * Today that is repository admin permission first and commit history second,
 * which is the difference between "Bitbucket says this person is accountable"
 * and "this person writes most of the code". Measured on this estate, admin
 * permission answers 78 of 95 repositories and commit history a further 7, so
 * the pair reaches 85 -- against 22 for commit history alone.
 *
 * When Entra ID lands it goes at the front of the list and nothing else
 * changes. That is the whole point of the resolver interface.
 *
 * The winner's `source` is recorded on every candidate row, so a reader can
 * always tell whether a name came from a declared permission or from an
 * inference.
 */
export class CompositeOwnershipResolver implements OwnershipResolver {
  private readonly resolvers: OwnershipResolver[];
  private readonly logger?: LoggerService;
  /** The resolver that produced the last proposal, for `source`. */
  private lastUsed?: OwnershipResolver;

  constructor(options: CompositeOwnershipResolverOptions) {
    if (options.resolvers.length === 0) {
      throw new Error('a composite resolver needs at least one resolver');
    }
    this.resolvers = options.resolvers;
    this.logger = options.logger;
  }

  /**
   * Reports the resolver that actually answered.
   *
   * Read by {@link OwnershipService} immediately after each `resolve`, which is
   * why this is safe despite looking like shared state: the service resolves
   * one repository at a time.
   */
  get source(): string {
    return this.lastUsed?.source ?? this.resolvers[0].source;
  }

  async prepare(workspace: string): Promise<void> {
    for (const resolver of this.resolvers) {
      await resolver.prepare?.(workspace);
    }
  }

  async resolve(
    repositoryId: number,
    since: Date,
    windowDays: number,
  ): Promise<OwnershipProposal> {
    let firstWithCandidates: OwnershipProposal | undefined;
    let firstWithCandidatesFrom: OwnershipResolver | undefined;

    for (const resolver of this.resolvers) {
      let proposal: OwnershipProposal;
      try {
        proposal = await resolver.resolve(repositoryId, since, windowDays);
      } catch (error) {
        // One source failing must not cost the repository every other source.
        this.logger?.warn(
          `Ownership resolver '${resolver.source}' failed for repository ` +
            `${repositoryId}, trying the next: ${(error as Error).message}`,
        );
        continue;
      }

      if (proposal.proposed) {
        this.lastUsed = resolver;
        return proposal;
      }
      // Keep the first source that at least found people, so a contested
      // repository still shows its candidates rather than nothing.
      if (!firstWithCandidates && proposal.candidates.length > 0) {
        firstWithCandidates = proposal;
        firstWithCandidatesFrom = resolver;
      }
    }

    this.lastUsed = firstWithCandidatesFrom ?? this.resolvers[0];
    return (
      firstWithCandidates ?? {
        candidates: [],
        windowCommits: 0,
        windowDays,
      }
    );
  }
}
