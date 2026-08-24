import type { Scorer } from '../types';

/**
 * A metric the document requires that has no data source yet.
 *
 * Registered rather than omitted so the gap is visible: the engine excludes it
 * from the total but reports its forfeited weight, which is what stops a
 * partial score from reading as a complete one.
 */
export function unmeasuredScorer(id: string, title: string): Scorer {
  return {
    id,
    title,
    score: () => null,
  };
}
