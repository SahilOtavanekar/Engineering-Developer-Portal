import type { BranchSummary } from '../database/BranchStore';
import type { RepositoryActivity } from '../database/CommitStore';
import type { PipelineSummary } from '../database/PipelineStore';
import type { ReviewSummary } from '../database/PullRequestStore';
import type { RepositoryRecord } from '../database/RepositoryStore';

/** Everything a scorer is allowed to look at. */
export interface ScorerContext {
  repository: RepositoryRecord;
  activity: RepositoryActivity;
  /** The activity window, in days, that `activity` covers. */
  windowDays: number;
  branches?: BranchSummary;
  pipelines?: PipelineSummary;
  reviews?: ReviewSummary;
  now: Date;
}

export interface ScorerOutcome {
  /** Fraction of this metric's weight earned, 0..1. */
  fraction: number;
  /** Short human-readable explanation, e.g. '237 commits in 90 days'. */
  detail: string;
}

/**
 * One health metric, self-contained and individually testable.
 *
 * Returning `null` from `score` means "cannot be measured yet" -- a missing
 * data source, not a failing repository. The engine excludes those from the
 * total rather than scoring them zero, so an incomplete portal does not
 * misreport a healthy repository as critical.
 */
export interface Scorer {
  id: string;
  title: string;
  score(context: ScorerContext): ScorerOutcome | null;
}

/** Per-metric result, as persisted and as served to the UI. */
export interface ScoreBreakdownEntry {
  id: string;
  title: string;
  weight: number;
  /** Absent when the metric could not be measured. */
  points?: number;
  detail: string;
  available: boolean;
}

export interface RepositoryScore {
  total: number;
  band: string;
  availableWeight: number;
  breakdown: ScoreBreakdownEntry[];
}
