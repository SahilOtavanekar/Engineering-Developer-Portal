import type { BranchSummary } from '../database/BranchStore';
import type { RepositoryActivity } from '../database/CommitStore';
import type { PipelineSummary } from '../database/PipelineStore';
import type { ReviewSummary } from '../database/PullRequestStore';
import type { RepositoryRecord } from '../database/RepositoryStore';
import type { StoredOwnershipCandidate } from '../database/OwnershipStore';
import type { BranchPolicySummary } from '../analysis/branchPolicy';

/**
 * Ownership as of the last resolution pass.
 *
 * The two absences mean different things and a scorer must not conflate them:
 * no `RepositoryOwnership` at all means **no pass has ever succeeded** for this
 * workspace, so ownership is unmeasurable; a `RepositoryOwnership` with no
 * `proposed` means a pass ran and **found nobody**, which is a real zero. The
 * distinction cannot be recovered from the candidate rows, because a repository
 * with no owner stores none.
 */
export interface RepositoryOwnership {
  /** Absent when a pass ran and had nobody to put forward. */
  proposed?: StoredOwnershipCandidate;
}

/**
 * How work reached the default branch, over the discipline scorer's window.
 *
 * Absent means the classification pass has not covered this repository, which
 * is not the same as a repository where nothing landed -- that is present with
 * `mainline: 0`. Only the first is unmeasurable.
 */
export interface RepositoryBranchPolicy extends BranchPolicySummary {
  /** The branch judged, for the detail line. */
  branch?: string;
}

/** Everything a scorer is allowed to look at. */
export interface ScorerContext {
  repository: RepositoryRecord;
  activity: RepositoryActivity;
  /** The activity window, in days, that `activity` covers. */
  windowDays: number;
  branches?: BranchSummary;
  pipelines?: PipelineSummary;
  reviews?: ReviewSummary;
  /** Absent when ownership has never been resolved. See the type. */
  ownership?: RepositoryOwnership;
  /** Absent until the branch policy pass has covered this repository. */
  branchPolicy?: RepositoryBranchPolicy;
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
