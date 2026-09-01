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
  /**
   * What would close the gap. Absent at full marks, and absent on any score
   * computed before remediation existed -- breakdowns are stored as JSON, so
   * old rows simply lack the field until the next pass rewrites them.
   */
  remediation?: string;
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

/** Branch health, and the worst offenders by name. */
export interface BranchSummaryView {
  total: number;
  active: number;
  stale: number;
  /** Longest-abandoned first. Excludes the default branch. */
  stalest: Array<{ name: string; lastCommitAt?: string }>;
  /**
   * Work sitting on branches that never reached the default branch.
   *
   * Absent until the divergence pass has run -- which is not the same as
   * nothing being stranded, and is why `measured` is reported alongside the
   * counts. Branches that are the source of a merged pull request are excluded
   * from the measurement entirely: 51% of merged pull requests here are
   * squashed, and a squash leaves the original commits unreachable from the
   * default branch for ever, so those branches would read as fully diverged
   * when their work has actually shipped.
   */
  divergence?: {
    /** Branches actually measured. */
    measured: number;
    /** Of those, how many hold unmerged work. */
    diverged: number;
    /** Commits stranded across them. */
    commits: number;
    /** A branch hit the one-page cap, so `commits` is a floor, not a total. */
    capped: boolean;
    /** Worst first. */
    worst: Array<{ name: string; commits: number; capped: boolean }>;
  };
}

/** Someone who might own a repository, with the evidence for it. */
export interface OwnershipCandidateView {
  name?: string;
  email?: string;
  commits: number;
}

/**
 * A derived suggestion about who owns a repository. **Not ownership.**
 *
 * Confirmed ownership is the catalog's `spec.owner`. This is a proposal drawn
 * from commit history, kept separate precisely so the two are never confused:
 * a guess presented as a fact is worse than a visible gap.
 */
export interface OwnershipProposalView {
  /** Where the proposal came from, e.g. `commit-history`. */
  source: string;
  /** Absent when no candidate was clearly enough ahead to name. */
  proposed?: OwnershipCandidateView;
  /** Strongest first, including the proposed one. */
  candidates: OwnershipCandidateView[];
  /** Commits considered, so the share can be shown rather than asserted. */
  windowCommits: number;
  windowDays: number;
  resolvedAt: string;
}

/**
 * How the commit trend is bucketed, chosen from the window's length.
 *
 * Adaptive because one rule cannot serve every period: a month bucketed
 * monthly is a single bar, and 90 days bucketed daily is 90 of them. Reported
 * in the payload so the chart can say which it is rather than leaving the
 * reader to infer it from the bar count.
 */
export type TrendBucket = 'day' | 'week' | 'month';

/** One bucket of an engineer's commit history. */
export interface CommitTrendPoint {
  /**
   * ISO timestamp of the bucket's start.
   *
   * Named `start` rather than `month`: the bucket is a day, a week or a month
   * depending on the window, and a field called `month` holding a Tuesday is
   * the kind of thing that is believed until it matters.
   */
  start: string;
  commits: number;
}

/** One repository an engineer committed to inside the window. */
export interface EngineerRepository {
  slug: string;
  commits: number;
}

/**
 * One engineer's figures, over whatever window was requested.
 *
 * Section 8 asks for ten measures. Eight are here. **Lines added and deleted
 * are absent**: Bitbucket only exposes them through a per-commit diffstat
 * endpoint, which is one request per commit -- about 4,000 for this estate,
 * eight times a full sweep -- so whether to pay that is a product decision, not
 * a technical one.
 */
export interface EngineerProductivity {
  /** Stable slug from the identity register. */
  key: string;
  name: string;
  /** Absent for someone who reviews but has never committed. */
  email?: string;
  commits: number;
  /** Distinct repositories they committed to in the window. */
  activeRepositories: number;
  lastCommitAt?: string;
  pullRequestsCreated: number;
  /** Of the ones they created. */
  pullRequestsMergedOfTheirOwn: number;
  /** Pull requests they took part in, whoever wrote them. */
  pullRequestsReviewed: number;
  /** Of those, how many they approved. */
  pullRequestsApproved: number;
  /** Pull requests they pressed merge on, whoever wrote them. */
  pullRequestsMerged: number;
  /** Mean hours from opening to merge, across their own pull requests. */
  averageMergeHours?: number;
  /** Oldest bucket first. */
  commitTrend: CommitTrendPoint[];
  /**
   * Repositories they committed to in the window, busiest first.
   *
   * Named rather than counted -- `activeRepositories` gives the number.
   * Measured at 107 author-repository pairs across the whole estate, so this
   * adds a few kilobytes rather than warranting its own endpoint.
   */
  repositories: EngineerRepository[];
}

/** The productivity dashboard payload. */
export interface ProductivityOverview {
  generatedAt: string;
  window: {
    since: string;
    until?: string;
    /** Present when scoped to one repository. */
    repositorySlug?: string;
  };
  /** Busiest first. */
  engineers: EngineerProductivity[];
  /** How `commitTrend` is bucketed, derived from the window's length. */
  trendBucket: TrendBucket;
  /** Repository slugs with activity in the window, for the filter. */
  repositories: string[];
  /**
   * Names and addresses the identity register could not account for.
   *
   * Surfaced rather than dropped: an unregistered engineer looks exactly like
   * one who did nothing, and this is the difference between a gap in the
   * register and a gap in someone's output.
   */
  unattributed: {
    commitAddresses: string[];
    pullRequestNames: string[];
    /** Commits those addresses account for. */
    commits: number;
  };
}

/** What is currently running in one environment. */
export interface EnvironmentView {
  /** The environment name as Bitbucket has it, e.g. `production`. */
  name: string;
  /** Bitbucket's own normalisation: Test, Staging or Production. */
  type?: string;
  releaseName?: string;
  commitHash?: string;
  deployedAt: string;
}

/**
 * A repository's whole recorded life, as opposed to the activity window.
 *
 * The window answers "is this maintained now"; this answers "what is this".
 * Two commits ever and 500 commits ever are very different objects, and both
 * look identical through a 90-day window once the work stops.
 */
export interface LifetimeSummaryView {
  commits: number;
  authors: number;
  /** Effectively the project's age. */
  firstCommitAt?: string;
  /** The newest commit at all, however far outside the activity window. */
  lastCommitAt?: string;
}

/**
 * Recent pipeline runs by outcome -- the four states section 6 asks for.
 *
 * `cancelled` is reported separately from `failed` and excluded from
 * `successRate`: a build somebody stopped says nothing about whether the code
 * builds.
 */
export interface PipelineSummaryView {
  successful: number;
  failed: number;
  cancelled: number;
  running: number;
  /** Successful over judged runs. Absent when there is nothing to judge. */
  successRate?: number;
  lastResult?: string;
  lastRunAt?: string;
}

/** Pull request throughput over the activity window. */
export interface ReviewSummaryView {
  merged: number;
  approved: number;
  open: number;
  /** Median hours from opening to merge. Absent when nothing merged. */
  medianMergeHours?: number;
  /**
   * Median hours from opening to the first approval -- how long the author
   * waited to be unblocked. A different measurement from merge duration, and
   * absent when nothing in the window was approved.
   */
  medianReviewHours?: number;
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
  branches?: BranchSummaryView;
  /** Absent until commit history has been ingested for the repository. */
  lifetime?: LifetimeSummaryView;
  /**
   * Who made the repository's earliest commit, and when.
   *
   * The only available answer to "who created this". Verified against the live
   * API: the Bitbucket repository object's `owner` is the *workspace*
   * (`{"type":"team","display_name":"DemandAI"}`), and there is no `creator`,
   * `created_by` or `author` field on it at all.
   *
   * `importedHistory` is the honesty flag. On 5 of 96 repositories here the
   * earliest commit predates the repository's own creation date -- history
   * carried in from somewhere else -- so its author wrote the oldest *imported*
   * commit and need never have touched this repository. Present on all 96.
   */
  createdBy?: {
    /** From the identity register; absent when the address is unregistered. */
    name?: string;
    email?: string;
    /** The earliest commit's timestamp, not the repository's creation date. */
    firstCommitAt: string;
    /** Bitbucket's own `created_on`, for comparison. */
    repositoryCreatedAt?: string;
    /** Earliest commit predates repository creation: the name is weak evidence. */
    importedHistory: boolean;
    /** The register says this address belongs to no person -- a bot or a tool. */
    notAPerson: boolean;
  };
  /**
   * Everyone who authored a commit on the default branch inside the activity
   * window, busiest first.
   *
   * Named rather than counted: `activity.authors` already gives the number.
   * Resolved through the identity register, so one human committing under two
   * addresses is one contributor here -- the raw addresses would report several
   * people. Bots and merge commits are excluded, matching every other activity
   * figure on the card.
   *
   * Empty for the 48 of 96 repositories with no commits in the window; that is
   * dormancy, reported separately, not an absence of contributors.
   */
  contributors?: Array<{
    name?: string;
    email?: string;
    commits: number;
    /** No identity-register entry. Named anyway, so nobody is silently erased. */
    unregistered: boolean;
  }>;
  pipelines?: PipelineSummaryView;
  reviews?: ReviewSummaryView;
  /**
   * Who commit history suggests owns this, awaiting confirmation. Absent
   * until the first ownership pass has covered the repository.
   */
  ownershipProposal?: OwnershipProposalView;
  /**
   * Latest completed deployment per environment, promotion order first.
   *
   * Empty when Bitbucket holds no deployment records for the repository --
   * which usually means its pipeline's `deployment:` value does not match a
   * configured environment name, not that nothing was ever deployed.
   */
  environments?: EnvironmentView[];
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
  /**
   * Who made the earliest commit -- the only available answer to who created
   * the repository, since Bitbucket exposes no creator at all.
   *
   * Compact by design: the estate listing carries a name, and the evidence
   * behind it -- the first commit date, the repository's own creation date,
   * whether history was imported -- stays on the repository page.
   */
  createdBy?: {
    name?: string;
    email?: string;
    /** Earliest commit predates the repository: weak evidence, flagged. */
    importedHistory: boolean;
  };
  /**
   * Everyone who committed inside the activity window, busiest first.
   *
   * Names only, no counts: the listing ranks and filters, it does not explain.
   * Per-person commit totals are on the repository page. Measured across this
   * estate at 1-5 people per active repository, so this adds a few hundred
   * bytes to the response rather than a few hundred kilobytes.
   */
  contributors?: string[];
  /**
   * When this repository's most recent pipeline run started.
   *
   * The estate listing is ordered by the *day* of this, newest first, then by
   * score within the day. Absent means the repository has never run a pipeline
   * -- 47 of 96 here -- which is not the same as a run that failed, and sorts
   * to the bottom rather than to the top.
   */
  lastPipelineRunAt?: string;
  /**
   * Who commit history suggests owns this. **A proposal, not ownership** --
   * the catalog still records `group:default/unowned` for everything.
   */
  proposedOwner?: OwnershipCandidateView;
  /**
   * Commits that reached the default branch without a pull request.
   *
   * Absent until the branch policy pass has covered the repository, which is
   * not the same as zero -- so the filter must not treat a missing value as
   * clean.
   */
  directCommits?: {
    /** Direct commits and direct merges together. */
    total: number;
    /** How many of those were merges with no pull request behind them. */
    merges: number;
    /** Commits on the branch's own history, for context. */
    mainline: number;
    windowDays: number;
  };
  /**
   * Problems, compacted for the estate listing.
   *
   * Deliberately not the whole breakdown: 96 repositories times eight metrics
   * with their detail and remediation strings would add tens of kilobytes to
   * the one endpoint the two-second page load depends on. The detail lives on
   * the repository's own page; this carries only what a list needs to count,
   * rank and filter.
   *
   * Absent until a scoring pass has covered the repository, which is not the
   * same as having no problems.
   */
  problems?: {
    /** Actionable gaps, worst first. */
    top: Array<{ id: string; title: string; lost: number }>;
    lostPoints: number;
    /** Present only when nothing landed in the activity window. */
    dormancy?: 'never-started' | 'abandoned';
  };
  /** Absent until a scoring run has covered this repository. */
  score?: {
    total: number;
    band: string;
    availableWeight: number;
    computedAt: string;
  };
}

/**
 * The whole estate, most recently built first, worst score leading each day.
 *
 * Ordered server-side so every client agrees on the order. Repositories are
 * grouped by the **UTC day** of their last pipeline run, newest day first, and
 * ranked by score **ascending** within each day -- so today's builds lead, and
 * the ones needing attention lead those. Day rather than timestamp because
 * every one of the 49 timestamps in this estate is distinct, so ordering on the
 * instant would make score a tiebreak that never fires.
 *
 * Repositories that have never run a pipeline sort last, worst first among
 * themselves. Unscored ones sort last of all: with worst-first scoring, placing
 * them at the top would read as a claim that they are the worst in the estate,
 * when they are an absence of information.
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
