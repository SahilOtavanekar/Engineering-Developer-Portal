export { fleetPermissions, fleetRepositoryReadPermission } from './permissions';
export { OWNERSHIP_SOURCE_REGISTER, isConfirmedOwnership } from './ownership';
export { canonicalBand, isSatisfactoryBand } from './bands';
export {
  deriveProblems,
  describeDormancy,
  isPortalGap,
  shouldHighlightProblems,
} from './problems';
export type {
  Dormancy,
  DormancyKind,
  Problem,
  ProblemKind,
  RepositoryProblems,
} from './problems';
export type {
  BranchSummaryView,
  CommitTrendPoint,
  EngineerRepository,
  TrendBucket,
  EngineerProductivity,
  ProductivityOverview,
  EnvironmentView,
  FleetOverview,
  FleetRepositorySummary,
  LifetimeSummaryView,
  OwnershipCandidateView,
  PipelineSummaryView,
  OwnershipProposalView,
  RepositoryActivitySummary,
  RepositoryFacts,
  RepositoryScoreSummary,
  ReviewSummaryView,
  ScoreHistoryPoint,
  ScoreBreakdownEntry,
} from './types';
