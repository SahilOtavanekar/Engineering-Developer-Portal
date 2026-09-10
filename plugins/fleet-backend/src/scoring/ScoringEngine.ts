import type {
  RepositoryScore,
  ScoreBreakdownEntry,
  Scorer,
  ScorerContext,
} from './types';

export interface ScoreBands {
  /** Total at or above which a repository is Excellent. */
  excellent: number;
  /** Total at or above which a repository is Healthy. */
  healthy: number;
  /** Total at or above which a repository Needs Attention. Below is At Risk. */
  needsAttention: number;
}

export interface ScoringEngineOptions {
  scorers: Array<{ scorer: Scorer; weight: number }>;
  bands: ScoreBands;
}

/**
 * The four documented health classifications.
 *
 * **No longer provisional.** These were guesses at 70 / 40 across three bands
 * until the product owner specified them, which is what closed open decision 2:
 * Excellent 90-100, Healthy 75-89, Needs Attention 60-74, At Risk below 60.
 * They stay in config because they decide which teams are told their
 * repository is failing, but the defaults are now the specification rather
 * than a placeholder.
 *
 * Note that the healthy floor rose from 70 to 75, so the same repository
 * scoring the same points can drop a band across this change with nothing
 * about it having got worse. Score history is append-only and cannot be
 * restated, so the trend genuinely does contain a step here.
 */
export const DEFAULT_BANDS: ScoreBands = {
  excellent: 90,
  healthy: 75,
  needsAttention: 60,
};

/**
 * The band a total falls in.
 *
 * `at-risk` was called `critical` while there were three bands. The name in the
 * specification is At Risk, and the band string is what the `score.band` column
 * stores, so it is renamed rather than merely relabelled in the UI -- otherwise
 * anyone reading the table sees a word the specification does not use. Rows
 * written before the rename keep `critical`; the frontend's band maps carry it
 * as a legacy key so they still render until the next pass rewrites them.
 */
export function bandFor(total: number, bands: ScoreBands): string {
  if (total >= bands.excellent) return 'excellent';
  if (total >= bands.healthy) return 'healthy';
  if (total >= bands.needsAttention) return 'needs-attention';
  return 'at-risk';
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
        // Only carried when the metric actually lost something; a remediation
        // beside full marks is noise in the payload and on the page.
        ...(outcome.remediation && fraction < 1
          ? { remediation: outcome.remediation }
          : {}),
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
