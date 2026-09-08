import type {
  HttpAuthService,
  LoggerService,
  PermissionsService,
} from '@backstage/backend-plugin-api';
import {
  fleetRepositoryReadPermission,
  type FleetOverview,
  type FleetRepositorySummary,
  type RepositoryFacts,
} from '@internal/backstage-plugin-fleet-common';
import { AuthorizeResult } from '@backstage/plugin-permission-common';
import express from 'express';
import Router from 'express-promise-router';
import type { BranchStore } from './database/BranchStore';
import type { CommitStore } from './database/CommitStore';
import type { DeploymentStore } from './database/DeploymentStore';
import type { OwnershipStore } from './database/OwnershipStore';
import type { PipelineStore } from './database/PipelineStore';
import type { PullRequestStore } from './database/PullRequestStore';
import type { ScoreStore } from './database/ScoreStore';
import type {
  RepositoryRecord,
  RepositoryStore,
} from './database/RepositoryStore';
import { deriveProblems } from '@internal/backstage-plugin-fleet-common';
import type { ProductivityService } from './productivity/ProductivityService';
import {
  EMPTY_IDENTITY_REGISTER,
  isNotAPerson,
  resolveEngineer,
  type IdentityRegister,
} from './identity/identityRegister';

export interface RouterOptions {
  repositories: RepositoryStore;
  commits: CommitStore;
  branches: BranchStore;
  pullRequests: PullRequestStore;
  deployments: DeploymentStore;
  pipelines: PipelineStore;
  ownership: OwnershipStore;
  scores: ScoreStore;
  /** Nominal total across every registered metric, measurable or not. */
  nominalWeight: number;
  httpAuth: HttpAuthService;
  permissions: PermissionsService;
  logger: LoggerService;
  /** Window used for the activity summary. Defaults to 90 days. */
  activityWindowDays?: number;
  /**
   * Window for direct-commit counts. Defaults to 30 days, matching the scorer:
   * a longer one reports behaviour that has largely already stopped.
   */
  disciplineWindowDays?: number;
  /**
   * Per-engineer productivity. Absent means the endpoint reports that it is not
   * configured rather than returning empty figures, which would read as
   * "nobody did anything".
   */
  productivity?: ProductivityService;
  /** Default window for productivity, in days. Defaults to 90. */
  productivityWindowDays?: number;
  /**
   * Maps commit addresses to people, for the repository creator and the
   * contributor list. Defaults to empty, which reports raw addresses rather
   * than failing -- the register is optional configuration.
   */
  identity?: IdentityRegister;
}

const DEFAULT_WINDOW_DAYS = 90;

/**
 * How many contributors the repository page lists.
 *
 * Measured across this estate: the busiest repository has 5 in 90 days and the
 * average is 2.3, so this truncates nothing today. It exists so a repository
 * that suddenly gains fifty contributors cannot bloat the response.
 */
const CONTRIBUTOR_LIMIT = 20;

/** Matches the scorer's default; see `pullRequestDisciplineScorer`. */
const DEFAULT_DISCIPLINE_WINDOW_DAYS = 30;

/** Past runs returned alongside a score. Enough to read a direction. */
const HISTORY_POINTS = 12;

function iso(value: Date | string | null | undefined): string | undefined {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function optional(value: string | null | undefined): string | undefined {
  return value ?? undefined;
}

/**
 * A repository's creator, compacted for the estate listing.
 *
 * The name only. The evidence behind it -- first commit date, repository
 * creation date -- stays on the repository page, which has room to explain
 * itself; a table cell does not.
 */
function summariseCreator(
  first: { email?: string; name?: string; committedAt: Date } | undefined,
  repositoryCreatedAt: Date | string | null | undefined,
  identity: IdentityRegister,
): FleetRepositorySummary['createdBy'] {
  if (!first) return undefined;
  if (isNotAPerson(identity, first.email)) return undefined;

  const person = resolveEngineer(identity, first.email);
  return {
    name: person?.name ?? first.name ?? undefined,
    email: person?.email ?? first.email ?? undefined,
    importedHistory: Boolean(
      repositoryCreatedAt &&
        first.committedAt.getTime() <
          new Date(repositoryCreatedAt).getTime() - 86_400_000,
    ),
  };
}

/**
 * Contributor names for the estate listing, busiest first.
 *
 * Merged by person, so a human committing under two addresses is one name --
 * grouping happens on the raw address in SQL and cannot do this itself.
 * Unregistered people keep their address rather than being dropped.
 */
function summariseContributors(
  rows: Array<{ email: string; commits: number }> | undefined,
  identity: IdentityRegister,
): string[] {
  if (!rows?.length) return [];

  const totals = new Map<string, { label: string; commits: number }>();
  for (const row of rows) {
    if (isNotAPerson(identity, row.email)) continue;
    const person = resolveEngineer(identity, row.email);
    const key = person?.key ?? `address:${row.email}`;
    const existing = totals.get(key);
    if (existing) {
      existing.commits += row.commits;
      continue;
    }
    totals.set(key, { label: person?.name ?? row.email, commits: row.commits });
  }

  return [...totals.values()]
    .sort((a, b) => b.commits - a.commits || a.label.localeCompare(b.label))
    .map(entry => entry.label);
}

/**
 * The ISO week an instant falls in, as the date of its Monday.
 *
 * **A week rather than the day it used to be, because the day bucket was too
 * fine to let score do anything.** Measured on this estate: 49 repositories
 * have pipeline runs spread over 24 distinct days, and **14 of those days hold
 * exactly one repository** -- so for 14 of them the worst-score half of the
 * ordering had nothing to rank, and the newest day in particular held a single
 * healthy repository, which put a 95 at the top of a dashboard whose stated job
 * is to lead with what needs attention. The same runs fall into 14 weeks, one
 * of which holds 18 repositories, so the ranking now bites where it did not.
 *
 * Monday, matching `date_trunc('week', ...)` in `ProductivityStore` and the
 * commit trend's buckets -- three places deciding independently when a week
 * starts is how a dashboard and a report come to disagree.
 *
 * UTC rather than local: a boundary that moved with the reader's timezone would
 * reorder the estate listing depending on who was looking at it. Returned as a
 * `YYYY-MM-DD` string, which orders lexicographically, so the comparator below
 * needs no date arithmetic of its own.
 */
function utcWeek(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return undefined;
  // getUTCDay is 0 for Sunday; shifting by 6 makes Monday 0 and Sunday 6.
  const offset = (at.getUTCDay() + 6) % 7;
  return new Date(at.getTime() - offset * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

export async function createRouter(
  options: RouterOptions,
): Promise<express.Router> {
  const {
    repositories,
    commits,
    branches,
    pullRequests,
    deployments,
    pipelines,
    ownership,
    scores,
    nominalWeight,
    httpAuth,
    permissions,
    activityWindowDays = DEFAULT_WINDOW_DAYS,
    disciplineWindowDays = DEFAULT_DISCIPLINE_WINDOW_DAYS,
    productivity,
    productivityWindowDays = DEFAULT_WINDOW_DAYS,
    identity = EMPTY_IDENTITY_REGISTER,
  } = options;

  const router = Router();
  router.use(express.json());

  /**
   * The whole estate, worst first.
   *
   * Ordered and counted server-side so every caller agrees on what needs
   * attention, and so the ordering cannot drift between the page and any
   * future consumer.
   */
  router.get('/repositories', async (req, res) => {
    const credentials = await httpAuth.credentials(req);
    const decision = await permissions.authorize(
      [{ permission: fleetRepositoryReadPermission }],
      { credentials },
    );
    if (decision[0]?.result !== AuthorizeResult.ALLOW) {
      res.status(403).json({ error: 'Not allowed to read repository facts' });
      return;
    }

    const workspace =
      typeof req.query.workspace === 'string' ? req.query.workspace : undefined;

    const records = await repositories.listLive(workspace);
    const ids = records.map(r => r.id);
    const disciplineSince = new Date(
      Date.now() - disciplineWindowDays * 24 * 60 * 60 * 1000,
    );
    // Contributors use the activity window, not the discipline one, so the
    // names match the "Authors (90d)" figure everywhere else in the portal.
    const overviewActivitySince = new Date(
      Date.now() - activityWindowDays * 24 * 60 * 60 * 1000,
    );
    const [
      latest,
      proposedOwners,
      policy,
      lifetimeCommits,
      lastPipelineRuns,
      firstCommits,
      contributorsByRepository,
    ] = await Promise.all([
      scores.latestForRepositories(ids),
      ownership.proposedForRepositories(ids),
      // One query for the estate, keyed by slug. A per-row lookup would be an
      // N+1 in the one endpoint the two-second page load depends on.
      commits.branchPolicyForWorkspace(
        workspace ?? records[0]?.workspace ?? '',
        disciplineSince,
      ),
      // Dormancy needs lifetime history to tell an abandoned service from a
      // scaffold. One query for the estate.
      commits.lifetimeCommitsForWorkspace(
        workspace ?? records[0]?.workspace ?? '',
      ),
      // One grouped query for the estate; the listing is ordered by this.
      pipelines.lastRunForRepositories(ids),
      // Creator and contributors, one grouped query each. Both must be
      // batched: this is the endpoint the two-second page load depends on.
      commits.firstCommitForRepositories(ids),
      commits.contributorsForRepositories(ids, overviewActivitySince),
    ]);

    const summaries: FleetRepositorySummary[] = records.map(record => {
      const score = latest.get(record.id);
      const owner = proposedOwners.get(record.id);
      const branchPolicy = policy.get(record.slug);
      // The same derivation the repository page uses, from fleet-common, so a
      // list and a detail page can never disagree about what is wrong.
      const problems = score
        ? deriveProblems(
            {
              total: score.total,
              band: score.band,
              availableWeight: score.available_weight,
              nominalWeight,
              computedAt: iso(score.computed_at)!,
              breakdown: score.breakdown,
            },
            { commits: lifetimeCommits.get(record.id) ?? 0, authors: 0 },
          )
        : undefined;
      return {
        entityRef: record.entity_ref,
        slug: record.slug,
        name: record.name,
        projectKey: optional(record.project_key),
        language: optional(record.language),
        derivedLanguage: optional(record.derived_language),
        techStack: record.tech_stack ?? undefined,
        lastCommitAt: iso(record.last_commit_at),
        lastPipelineRunAt: iso(lastPipelineRuns.get(record.id)),
        createdBy: summariseCreator(
          firstCommits.get(record.id),
          record.created_at,
          identity,
        ),
        contributors: summariseContributors(
          contributorsByRepository.get(record.id),
          identity,
        ),
        proposedOwner: owner
          ? {
              name: owner.name,
              email: owner.email,
              commits: owner.commits,
            }
          : undefined,
        directCommits: branchPolicy
          ? {
              total: branchPolicy.direct + branchPolicy.directMerge,
              merges: branchPolicy.directMerge,
              mainline: branchPolicy.mainline,
              windowDays: disciplineWindowDays,
            }
          : undefined,
        problems: problems
          ? {
              top: problems.actionable.map(problem => ({
                id: problem.id,
                title: problem.title,
                lost: Math.round(problem.lost * 10) / 10,
              })),
              lostPoints: Math.round(problems.lostPoints * 10) / 10,
              dormancy: problems.dormancy?.kind,
            }
          : undefined,
        score: score
          ? {
              total: score.total,
              band: score.band,
              availableWeight: score.available_weight,
              computedAt: iso(score.computed_at)!,
            }
          : undefined,
      };
    });

    // Newest build WEEK first, WORST score within the week.
    //
    // Recency decides which repositories are in play; the score then puts the
    // ones needing attention at the top of each bucket -- the question the
    // requirements document opens with, asked of the repositories that are
    // actually being worked on.
    //
    // A bucket rather than the instant: all 49 pipeline timestamps in this
    // estate are distinct, so ordering on the instant would make score a
    // tiebreak that never fires and would bury a failing repository under a
    // healthy one that finished its build four minutes later. The bucket is a
    // *week* rather than a day for the same reason one step out -- see
    // `utcWeek` for the measurement that forced it.
    //
    // Both absences sort last rather than first, and this is the subtle one --
    // with worst-first scoring, an unscored repository placed first would read
    // as the very worst in the estate. It is an absence of information, not a
    // bad result, and the same goes for one that has never run a pipeline
    // (47 of 96).
    summaries.sort((a, b) => {
      const weekA = utcWeek(a.lastPipelineRunAt);
      const weekB = utcWeek(b.lastPipelineRunAt);
      if (weekA !== weekB) {
        if (!weekA) return 1;
        if (!weekB) return -1;
        return weekB.localeCompare(weekA);
      }

      const scoreA = a.score?.total;
      const scoreB = b.score?.total;
      if (scoreA !== scoreB) {
        if (scoreA === undefined) return 1;
        if (scoreB === undefined) return -1;
        return scoreA - scoreB;
      }

      return a.slug.localeCompare(b.slug);
    });

    const counts = {
      healthy: summaries.filter(s => s.score?.band === 'healthy').length,
      needsAttention: summaries.filter(s => s.score?.band === 'needs-attention')
        .length,
      critical: summaries.filter(s => s.score?.band === 'critical').length,
      unscored: summaries.filter(s => !s.score).length,
    };

    const overview: FleetOverview = {
      generatedAt: new Date().toISOString(),
      nominalWeight,
      counts,
      repositories: summaries,
    };
    res.json(overview);
  });

  /**
   * Facts for one repository, addressed by its catalog entity ref.
   *
   * The ref is split across path segments rather than passed encoded: a
   * URL-encoded slash survives Express but not every proxy in front of it.
   */
  /**
   * Per-engineer figures for requirement 8.
   *
   * Window is expressed as `since`/`until` rather than month or quarter: those
   * are presentation, and putting them here would mean two places deciding when
   * a quarter starts. The caller sends the dates it means.
   *
   * **No access control beyond the read permission yet.** This is per-person
   * performance data and the portal runs `allow-all-policy`, so everyone who can
   * see the fleet can see everyone's figures. That is a deliberate, recorded gap
   * (CLAUDE.md open question 6), not an oversight.
   */
  router.get('/productivity', async (req, res) => {
    const credentials = await httpAuth.credentials(req);
    const decision = await permissions.authorize(
      [{ permission: fleetRepositoryReadPermission }],
      { credentials },
    );
    if (decision[0]?.result !== AuthorizeResult.ALLOW) {
      res.status(403).json({ error: 'Not allowed to read repository facts' });
      return;
    }

    if (!productivity) {
      res.status(501).json({
        error:
          'Productivity is not configured; set fleet.identity.register so ' +
          'commits can be attributed to people',
      });
      return;
    }

    const workspace =
      typeof req.query.workspace === 'string'
        ? req.query.workspace
        : (await repositories.listLive()).at(0)?.workspace ?? '';

    const parseDate = (value: unknown): Date | undefined => {
      if (typeof value !== 'string') return undefined;
      const parsed = new Date(value);
      return Number.isNaN(parsed.getTime()) ? undefined : parsed;
    };

    const since =
      parseDate(req.query.since) ??
      new Date(Date.now() - productivityWindowDays * 24 * 60 * 60 * 1000);
    const until = parseDate(req.query.until);
    const repositorySlug =
      typeof req.query.repository === 'string' && req.query.repository
        ? req.query.repository
        : undefined;

    res.json(
      await productivity.overview({
        workspace,
        since,
        until,
        repositorySlug,
      }),
    );
  });

  router.get(
    '/repositories/by-entity/:kind/:namespace/:name',
    async (req, res) => {
      const credentials = await httpAuth.credentials(req);
      const decision = await permissions.authorize(
        [{ permission: fleetRepositoryReadPermission }],
        { credentials },
      );
      if (decision[0]?.result !== AuthorizeResult.ALLOW) {
        res.status(403).json({ error: 'Not allowed to read repository facts' });
        return;
      }

      const { kind, namespace, name } = req.params;
      const entityRef = `${kind}:${namespace}/${name}`.toLowerCase();

      const record: RepositoryRecord | undefined =
        await repositories.findByEntityRef(entityRef);
      if (!record) {
        res.status(404).json({ error: `No repository facts for ${entityRef}` });
        return;
      }

      const since = new Date(
        Date.now() - activityWindowDays * 24 * 60 * 60 * 1000,
      );
      const [activity, lifetime, firstCommit, contributions] =
        await Promise.all([
          commits.activitySince(record.id, since),
          commits.lifetime(record.id),
          commits.firstCommit(record.id),
          // Reuses the grouped author query the ownership resolvers use, so
          // the names here cannot disagree with the ownership candidates.
          commits.topAuthorsSince(record.id, since, CONTRIBUTOR_LIMIT),
        ]);
      const [
        latestScore,
        scoreHistory,
        branchSummary,
        stalest,
        branchDivergence,
        reviews,
        environments,
        ownershipCandidates,
        pipelineSummary,
      ] = await Promise.all([
        scores.latest(record.id),
        scores.history(record.id, HISTORY_POINTS),
        branches.summary(record.id, since),
        branches.stalest(record.id, since),
        branches.divergenceSummary(record.id),
        pullRequests.reviewSummary(record.id, since),
        deployments.currentEnvironments(record.id),
        ownership.forRepository(record.id),
        pipelines.summary(record.id),
      ]);

      // Whether a candidate was confident enough to name was decided by the
      // resolver and recorded on the row. Re-deriving it here would duplicate
      // a configurable policy in a place that cannot see the config.
      const leader = ownershipCandidates[0];
      const proposedOwner = ownershipCandidates.find(c => c.isProposed);

      const createdBy = firstCommit
        ? (() => {
            const person = resolveEngineer(identity, firstCommit.email);
            return {
              name: person?.name ?? firstCommit.name ?? undefined,
              email: person?.email ?? firstCommit.email ?? undefined,
              firstCommitAt: firstCommit.committedAt.toISOString(),
              repositoryCreatedAt: iso(record.created_at),
              // History carried in from elsewhere: the earliest commit is older
              // than the repository, so its author may never have touched this
              // one. True for 5 of 96 here.
              importedHistory: Boolean(
                record.created_at &&
                  firstCommit.committedAt.getTime() <
                    new Date(record.created_at).getTime() - 86_400_000,
              ),
              notAPerson: isNotAPerson(identity, firstCommit.email),
            };
          })()
        : undefined;

      // Merged by person, not by address. `topAuthorsSince` groups on the raw
      // `author_email`, so a human committing under two addresses arrives as
      // two rows -- reporting them as two contributors of one commit each is
      // exactly the error the identity register exists to prevent.
      const merged = new Map<
        string,
        {
          name?: string;
          email?: string;
          commits: number;
          unregistered: boolean;
        }
      >();
      for (const contribution of contributions) {
        if (isNotAPerson(identity, contribution.email)) continue;
        const person = resolveEngineer(identity, contribution.email);
        const key = person?.key ?? `address:${contribution.email ?? 'unknown'}`;
        const existing = merged.get(key);
        if (existing) {
          existing.commits += contribution.commits;
          continue;
        }
        merged.set(key, {
          name: person?.name ?? contribution.name ?? undefined,
          email: person?.email ?? contribution.email ?? undefined,
          commits: contribution.commits,
          // Named anyway rather than dropped: someone missing from the
          // register looks exactly like someone who did nothing.
          unregistered: !person,
        });
      }
      const contributors = [...merged.values()].sort(
        (a, b) =>
          b.commits - a.commits ||
          (a.name ?? a.email ?? '').localeCompare(b.name ?? b.email ?? ''),
      );

      const facts: RepositoryFacts = {
        entityRef: record.entity_ref,
        workspace: record.workspace,
        slug: record.slug,
        url: record.url,
        description: optional(record.description),
        projectKey: optional(record.project_key),
        defaultBranch: optional(record.default_branch),
        language: optional(record.language),
        derivedLanguage: optional(record.derived_language),
        techStack: record.tech_stack ?? undefined,
        sizeBytes: record.size_bytes ?? undefined,
        isPrivate: record.is_private,
        createdAt: iso(record.created_at),
        updatedAt: iso(record.updated_at),
        lastCommitAt: iso(record.last_commit_at ?? activity.lastCommitAt),
        lastSyncedAt: iso(record.last_synced_at)!,
        activity: {
          windowDays: activityWindowDays,
          commits: activity.commits,
          authors: activity.authors,
        },
        branches: {
          ...branchSummary,
          stalest: stalest.map(branch => ({
            name: branch.name,
            lastCommitAt: iso(branch.lastCommitAt),
          })),
          // Omitted entirely when nothing has been measured: reporting zeroes
          // would say "no stranded work" where the truth is "not looked yet".
          divergence:
            branchDivergence.measured > 0 ? branchDivergence : undefined,
        },
        reviews,
        createdBy,
        contributors,
        lifetime: {
          commits: lifetime.commits,
          authors: lifetime.authors,
          firstCommitAt: iso(lifetime.firstCommitAt ?? null),
          lastCommitAt: iso(lifetime.lastCommitAt ?? null),
        },
        pipelines: {
          successful: pipelineSummary.successful,
          failed: pipelineSummary.failed,
          cancelled: pipelineSummary.cancelled,
          running: pipelineSummary.inProgress,
          successRate:
            pipelineSummary.judged > 0
              ? pipelineSummary.successful / pipelineSummary.judged
              : undefined,
          lastResult: pipelineSummary.lastResult,
          lastRunAt: iso(pipelineSummary.lastRunAt ?? null),
        },
        ownershipProposal: leader
          ? {
              source: leader.source,
              proposed: proposedOwner
                ? {
                    name: proposedOwner.name,
                    email: proposedOwner.email,
                    commits: proposedOwner.commits,
                  }
                : undefined,
              candidates: ownershipCandidates.map(candidate => ({
                name: candidate.name,
                email: candidate.email,
                commits: candidate.commits,
              })),
              windowCommits: leader.windowCommits,
              windowDays: leader.windowDays,
              resolvedAt: leader.resolvedAt.toISOString(),
            }
          : undefined,
        environments: environments.map(environment => ({
          name: environment.environmentName,
          type: environment.environmentType,
          releaseName: environment.releaseName,
          commitHash: environment.commitHash,
          deployedAt: environment.deployedAt.toISOString(),
        })),
        score: latestScore
          ? {
              total: latestScore.total,
              band: latestScore.band,
              availableWeight: latestScore.available_weight,
              nominalWeight,
              computedAt: iso(latestScore.computed_at)!,
              breakdown: latestScore.breakdown,
              // Reversed: the store returns newest first, but a trend reads
              // left to right in time order.
              history: scoreHistory
                .map(point => ({
                  total: point.total,
                  computedAt: iso(point.computed_at)!,
                }))
                .reverse(),
            }
          : undefined,
      };

      res.json(facts);
    },
  );

  return router;
}
