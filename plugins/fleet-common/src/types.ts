/** Commit activity over a bounded window. */
export interface RepositoryActivitySummary {
  windowDays: number;
  /** Merge commits excluded -- a merge is not authorship. */
  commits: number;
  authors: number;
}

/** One metric's contribution to a repository's health score. */
export interface ScoreBreakdownEntry {
  id: string;
  title: string;
  weight: number;
  /** Absent when the metric could not be measured. */
  points?: number;
  detail: string;
  available: boolean;
}

/** One past scoring run, for plotting a trend. */
export interface ScoreHistoryPoint {
  total: number;
  computedAt: string;
}

export interface RepositoryScoreSummary {
  total: number;
  /** 'healthy' | 'needs-attention' | 'critical'. */
  band: string;
  /**
   * How much of the nominal 100 was measurable. A total of 80 over 30
   * available weight means something very different from 80 over 100.
   */
  availableWeight: number;
  nominalWeight: number;
  computedAt: string;
  breakdown: ScoreBreakdownEntry[];
  /**
   * Recent scores, oldest first, including the current one.
   *
   * The trend is what changes behaviour -- a repository that moved from 40 to
   * 70 is a different story from one that has always been 70 -- so the series
   * travels with the score rather than needing a second request.
   */
  history?: ScoreHistoryPoint[];
}

/**
 * The facts the portal holds about one repository, as served to the frontend.
 *
 * Timestamps are ISO strings rather than Date objects: this crosses an HTTP
 * boundary, and pretending otherwise invites subtle deserialisation bugs.
 */
export interface RepositoryFacts {
  entityRef: string;
  workspace: string;
  slug: string;
  url: string;
  description?: string;
  projectKey?: string;
  defaultBranch?: string;
  language?: string;
  /** Derived from manifests. Distinct from Bitbucket's reported language. */
  derivedLanguage?: string;
  /** Ecosystems and frameworks derived from manifests. */
  techStack?: string[];
  sizeBytes?: number;
  isPrivate: boolean;
  createdAt?: string;
  updatedAt?: string;
  lastCommitAt?: string;
  lastSyncedAt: string;
  activity: RepositoryActivitySummary;
  /** Absent until the first scoring run has covered this repository. */
  score?: RepositoryScoreSummary;
}

/** One row of the fleet overview. */
export interface FleetRepositorySummary {
  entityRef: string;
  slug: string;
  name: string;
  projectKey?: string;
  language?: string;
  derivedLanguage?: string;
  techStack?: string[];
  lastCommitAt?: string;
  /** Absent until a scoring run has covered this repository. */
  score?: {
    total: number;
    band: string;
    availableWeight: number;
    computedAt: string;
  };
}

/**
 * The whole estate, worst first.
 *
 * Ordered server-side so every client agrees on what "needs attention" means,
 * which is the question the requirements document opens with.
 */
export interface FleetOverview {
  generatedAt: string;
  nominalWeight: number;
  counts: {
    healthy: number;
    needsAttention: number;
    critical: number;
    unscored: number;
  };
  repositories: FleetRepositorySummary[];
}
