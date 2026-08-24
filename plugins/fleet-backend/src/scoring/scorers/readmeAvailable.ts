import type { Scorer } from '../types';

/**
 * Does the repository explain itself?
 *
 * Binary, and deliberately so: a README either exists or it does not. Judging
 * its quality would need content analysis the portal does not do, and a
 * scaffolded README that nobody edited would score well regardless.
 *
 * Unmeasurable when the root listing has not been fetched yet, rather than
 * scored zero -- absence of data is not absence of a README.
 */
export function readmeAvailableScorer(): Scorer {
  return {
    id: 'readme-available',
    title: 'README available',
    score({ repository }) {
      if (
        repository.has_readme === null ||
        repository.has_readme === undefined
      ) {
        return null;
      }

      return {
        fraction: repository.has_readme ? 1 : 0,
        detail: repository.has_readme
          ? 'README present at the repository root'
          : 'No README at the repository root',
      };
    },
  };
}
