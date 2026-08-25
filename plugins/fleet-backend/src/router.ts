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
import type { PullRequestStore } from './database/PullRequestStore';
import type { ScoreStore } from './database/ScoreStore';
import type {
  RepositoryRecord,
  RepositoryStore,
} from './database/RepositoryStore';

export interface RouterOptions {
  repositories: RepositoryStore;
  commits: CommitStore;
  branches: BranchStore;
  pullRequests: PullRequestStore;
  deployments: DeploymentStore;
  ownership: OwnershipStore;
  scores: ScoreStore;
  /** Nominal total across every registered metric, measurable or not. */
  nominalWeight: number;
  httpAuth: HttpAuthService;
  permissions: PermissionsService;
  logger: LoggerService;
  /** Window used for the activity summary. Defaults to 90 days. */
  activityWindowDays?: number;
}

const DEFAULT_WINDOW_DAYS = 90;

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

export async function createRouter(
  options: RouterOptions,
): Promise<express.Router> {
  const {
    repositories,
    commits,
    branches,
    pullRequests,
    deployments,
    ownership,
    scores,
    nominalWeight,
    httpAuth,
    permissions,
    activityWindowDays = DEFAULT_WINDOW_DAYS,
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
    const [latest, proposedOwners] = await Promise.all([
      scores.latestForRepositories(ids),
      ownership.proposedForRepositories(ids),
    ]);

    const summaries: FleetRepositorySummary[] = records.map(record => {
      const score = latest.get(record.id);
      const owner = proposedOwners.get(record.id);
      return {
        entityRef: record.entity_ref,
        slug: record.slug,
        name: record.name,
        projectKey: optional(record.project_key),
        language: optional(record.language),
        derivedLanguage: optional(record.derived_language),
        techStack: record.tech_stack ?? undefined,
        lastCommitAt: iso(record.last_commit_at),
        proposedOwner: owner
          ? {
              name: owner.name,
              email: owner.email,
              commits: owner.commits,
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

    // Worst first. Unscored repositories sort last: they are an absence of
    // information, not a bad result, and burying them under real problems
    // would be misleading.
    summaries.sort((a, b) => {
      if (a.score && b.score) {
        return a.score.total - b.score.total || a.slug.localeCompare(b.slug);
      }
      if (a.score) return -1;
      if (b.score) return 1;
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
      const activity = await commits.activitySince(record.id, since);
      const [
        latestScore,
        scoreHistory,
        branchSummary,
        stalest,
        reviews,
        environments,
        ownershipCandidates,
      ] = await Promise.all([
        scores.latest(record.id),
        scores.history(record.id, HISTORY_POINTS),
        branches.summary(record.id, since),
        branches.stalest(record.id, since),
        pullRequests.reviewSummary(record.id, since),
        deployments.currentEnvironments(record.id),
        ownership.forRepository(record.id),
      ]);

      // Whether a candidate was confident enough to name was decided by the
      // resolver and recorded on the row. Re-deriving it here would duplicate
      // a configurable policy in a place that cannot see the config.
      const leader = ownershipCandidates[0];
      const proposedOwner = ownershipCandidates.find(c => c.isProposed);

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
        },
        reviews,
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
