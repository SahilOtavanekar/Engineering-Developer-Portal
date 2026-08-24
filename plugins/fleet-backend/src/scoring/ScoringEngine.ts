import type {
  RepositoryScore,
  ScoreBreakdownEntry,
  Scorer,
  ScorerContext,
} from './types';

export interface ScoreBands {
  /** Total at or above which a repository is Healthy. */
  healthy: number;
  /** Total at or above which a repository Needs Attention. Below is Critical. */
  needsAttention: number;
}

export interface ScoringEngineOptions {
  scorers: Array<{ scorer: Scorer; weight: number }>;
  bands: ScoreBands;
}

/**
 * Provisional until someone with authority owns the numbers. They determine
 * which teams get told their repository is failing, so they are config rather
 * than code and are labelled provisional wherever they are shown.
 */
export const PROVISIONAL_BANDS: ScoreBands = {
  healthy: 70,
  needsAttention: 40,
};

export function bandFor(total: number, bands: ScoreBands): string {
  if (total >= bands.healthy) return 'healthy';
  if (total >= bands.needsAttention) return 'needs-attention';
  return 'critical';
}

/**
 * Runs a registry of independent scorers and combines their results.
 *
 * Metrics that cannot be measured are excluded from the total and the score is
 * renormalised over the weight that remained. Scoring an unmeasurable metric
 * zero would report the portal's own incompleteness as a failing repository --
 * and `availableWeight` is carried through so a partial score can never be
 * mistaken for a complete one.
 */
export class ScoringEngine {
  private readonly scorers: Array<{ scorer: Scorer; weight: number }>;
  private readonly bands: ScoreBands;

  constructor(options: ScoringEngineOptions) {
    this.scorers = options.scorers.filter(s => s.weight > 0);
    this.bands = options.bands;
  }

  /** Nominal total across every registered metric, measurable or not. */
  get nominalWeight(): number {
    return this.scorers.reduce((sum, s) => sum + s.weight, 0);
  }

  score(context: ScorerContext): RepositoryScore {
    const breakdown: ScoreBreakdownEntry[] = [];
    let earned = 0;
    let availableWeight = 0;

    for (const { scorer, weight } of this.scorers) {
      const outcome = scorer.score(context);

      if (!outcome) {
        breakdown.push({
          id: scorer.id,
          title: scorer.title,
          weight,
          detail: 'Not measured yet',
          available: false,
        });
        continue;
      }

      const fraction = Math.min(1, Math.max(0, outcome.fraction));
      const points = fraction * weight;

      earned += points;
      availableWeight += weight;
      breakdown.push({
        id: scorer.id,
        title: scorer.title,
        weight,
        points: Math.round(points * 10) / 10,
        detail: outcome.detail,
        available: true,
      });
    }

    // No measurable metric at all: report zero explicitly rather than dividing
    // by zero and calling the result healthy.
    const total =
      availableWeight === 0 ? 0 : Math.round((earned / availableWeight) * 100);

    return {
      total,
      band: bandFor(total, this.bands),
      availableWeight,
      breakdown,
    };
  }
}
