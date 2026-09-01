import type { Scorer } from '../types';

/**
 * Are this repository's builds passing?
 *
 * Scored as a success rate over recent judged runs rather than on the latest
 * run alone: a single flake should not take a healthy repository to zero.
 *
 * Two kinds of run are excluded from the denominator rather than counted as
 * failures: those still in progress, and those somebody cancelled. A build a
 * human stopped -- usually because a newer commit superseded it -- is not
 * evidence that the code is broken, and treating it as one penalised every
 * repository that cancels superseded builds.
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
      // `judged` rather than `completed`: a repository whose only finished
      // runs were all cancelled has nothing to judge, which is unmeasurable
      // rather than a zero.
      if (!pipelines || pipelines.judged === 0) {
        return null;
      }

      const { successful, judged, cancelled } = pipelines;
      const aside = cancelled > 0 ? `, ${cancelled} cancelled` : '';
      return {
        fraction: successful / judged,
        remediation: `${
          judged - successful
        } of the last ${judged} judged runs failed. Cancelled runs are already excluded, so these are real failures.`,
        detail: `${successful} of ${judged} recent run${
          judged === 1 ? '' : 's'
        } passed${aside}`,
      };
    },
  };
}
