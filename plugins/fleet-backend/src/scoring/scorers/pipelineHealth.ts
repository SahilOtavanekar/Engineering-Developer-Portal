import type { Scorer } from '../types';

/**
 * Are this repository's builds passing?
 *
 * Scored as a success rate over recent completed runs rather than on the
 * latest run alone: a single flake should not take a healthy repository to
 * zero. Runs still in progress are excluded rather than counted as failures.
 *
 * A repository with no completed runs is unmeasurable, not failing. Sixty per
 * cent of this estate has no pipeline at all, and we cannot tell "CI is broken"
 * apart from "CI was never set up, and may not be needed".
 */
export function pipelineHealthScorer(): Scorer {
  return {
    id: 'pipeline-passing',
    title: 'Pipeline passing',
    score({ pipelines }) {
      if (!pipelines || pipelines.completed === 0) {
        return null;
      }

      const { successful, completed } = pipelines;
      return {
        fraction: successful / completed,
        detail: `${successful} of ${completed} recent run${
          completed === 1 ? '' : 's'
        } passed`,
      };
    },
  };
}
