import { OWNERSHIP_SOURCE_REGISTER } from '../../ownership/types';
import type { Scorer } from '../types';

/**
 * Whether anybody is actually accountable for this repository.
 *
 * **A derived owner earns nothing.** The portal can name a likely owner for
 * almost every repository by looking at admin permissions or commit history,
 * and if a guess scored it would report the estate as owned while nobody had
 * agreed to own anything. Measured against the standardization document, those
 * two inferences were right 76% and 78% of the time -- good enough to suggest a
 * name to a human, nowhere near good enough to count as ownership.
 *
 * So this is binary and deliberately hard to earn: full marks for an owner
 * somebody confirmed, nothing otherwise. The detail line says which, so a
 * repository scoring zero here tells its team what to do about it rather than
 * just docking them ten points.
 *
 * Returns `null` -- not zero -- when ownership has never been resolved for the
 * workspace. Scoring 95 repositories zero because a scheduled task has not run
 * yet would misreport every one of them.
 */
export function ownerAssignedScorer(): Scorer {
  return {
    id: 'owner-assigned',
    title: 'Owner assigned',
    score: ({ ownership }) => {
      if (!ownership) return null;

      const { proposed } = ownership;
      if (!proposed?.email) {
        return {
          fraction: 0,
          detail: 'No owner identified',
        };
      }

      const who = proposed.name ?? proposed.email;
      if (proposed.source !== OWNERSHIP_SOURCE_REGISTER) {
        return {
          fraction: 0,
          detail: `${who} is a likely owner, derived from ${proposed.source}, but nobody has confirmed it`,
        };
      }

      return {
        fraction: 1,
        detail: `Owner confirmed: ${who}`,
      };
    },
  };
}
