import type { Scorer } from '../types';

/**
 * How much abandoned work is lying around?
 *
 * The fraction of branches touched inside the activity window. A repository
 * carrying twenty branches last committed to nine months ago is harder to
 * reason about and riskier to change, which is what section 6 means by stale
 * and long-running branches.
 *
 * No branches at all means an empty repository -- unmeasurable rather than
 * perfect, since scoring it full marks would flatter a repository with nothing
 * in it.
 */
export function branchHygieneScorer(): Scorer {
  return {
    id: 'branch-hygiene',
    title: 'Branch hygiene',
    score({ branches, windowDays }) {
      if (!branches || branches.total === 0) {
        return null;
      }

      const { active, total } = branches;
      return {
        fraction: active / total,
        remediation:
          active === 0
            ? undefined
            : `${
                total - active
              } of ${total} branches saw no commits in the window. Delete the merged ones.`,
        detail: `${active} of ${total} branch${
          total === 1 ? '' : 'es'
        } active in ${windowDays} days`,
      };
    },
  };
}
