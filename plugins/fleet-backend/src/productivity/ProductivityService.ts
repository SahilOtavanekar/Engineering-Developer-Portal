import type { LoggerService } from '@backstage/backend-plugin-api';
import type {
  EngineerProductivity,
  ProductivityOverview,
  TrendBucket,
} from '@internal/backstage-plugin-fleet-common';
import type {
  ProductivityStore,
  ProductivityWindow,
} from '../database/ProductivityStore';
import { normaliseName } from '../ownership/identity';
import {
  isNotAPerson,
  resolveEngineer,
  type IdentityRegister,
  type RegisteredEngineer,
} from '../identity/identityRegister';

export interface ProductivityServiceOptions {
  store: ProductivityStore;
  register: IdentityRegister;
  logger: LoggerService;
}

/** A mutable accumulator, one per person, before it becomes a view object. */
interface Tally {
  person: RegisteredEngineer;
  commits: number;
  activeRepositories: number;
  lastCommitAt?: Date;
  created: number;
  mergedOwn: number;
  reviewed: number;
  approved: number;
  merged: number;
  averageMergeHours?: number;
  trend: Map<number, number>;
  /** Repository slug to commits, summed across all of the person's addresses. */
  repositories: Map<string, number>;
}

/**
 * Assembles the per-engineer figures for requirement 8.
 *
 * The whole reason this exists as a service rather than a query: **commits and
 * pull requests identify people differently**. A commit carries an address and
 * no reliable name; a pull request carries a display name and an account id but
 * no address, because `GET /2.0/users/{account_id}` is 403 for this token. So
 * commits resolve through the identity register's addresses and pull requests
 * through its names, and both funnel into one person.
 *
 * Measured on this estate: **332 of 332 pull request authors matched a
 * registered name**, and every one of the 29 commit addresses resolves. Anything
 * that fails is reported in `unattributed` rather than dropped -- an engineer
 * missing from the register looks exactly like one who did nothing, and only one
 * of those is worth a conversation.
 *
 * Costs no Bitbucket requests: every figure comes from data already stored.
 */
/**
 * Bucket size for the commit trend, from the window's length.
 *
 * One rule cannot serve every period the page offers: a month bucketed monthly
 * is a single bar, and 90 days bucketed daily is ninety of them. The
 * boundaries are generous so a period never lands on a knife edge -- "this
 * month" on the 31st is still daily, and a quarter is still weekly.
 */
export function bucketForWindow(since: Date, until?: Date): TrendBucket {
  const days = ((until ?? new Date()).getTime() - since.getTime()) / 86_400_000;
  if (days <= 45) return 'day';
  if (days <= 200) return 'week';
  return 'month';
}

export class ProductivityService {
  private readonly store: ProductivityStore;
  private readonly register: IdentityRegister;
  private readonly logger: LoggerService;

  constructor(options: ProductivityServiceOptions) {
    this.store = options.store;
    this.register = options.register;
    this.logger = options.logger;
  }

  /** Normalised display name to person, for the pull request side. */
  private nameIndex(): Map<string, RegisteredEngineer> {
    const index = new Map<string, RegisteredEngineer>();
    for (const person of this.register.people) {
      const key = normaliseName(person.name);
      if (key && !index.has(key)) index.set(key, person);
    }
    return index;
  }

  async overview(window: ProductivityWindow): Promise<ProductivityOverview> {
    const trendBucket = bucketForWindow(window.since, window.until);
    const [
      commits,
      trend,
      authored,
      participation,
      mergedBy,
      repositories,
      authorRepositories,
    ] = await Promise.all([
      this.store.commitsByAuthor(window),
      this.store.commitTrendByAuthor(window, trendBucket),
      this.store.authoredPullRequests(window),
      this.store.participation(window),
      this.store.mergedBy(window),
      this.store.repositoriesWithActivity(window),
      this.store.repositoriesByAuthor(window),
    ]);

    const byName = this.nameIndex();
    const tallies = new Map<string, Tally>();
    const unknownAddresses = new Set<string>();
    const unknownNames = new Set<string>();
    let unattributedCommits = 0;

    const tally = (person: RegisteredEngineer): Tally => {
      const existing = tallies.get(person.key);
      if (existing) return existing;
      const fresh: Tally = {
        person,
        commits: 0,
        activeRepositories: 0,
        created: 0,
        mergedOwn: 0,
        reviewed: 0,
        approved: 0,
        merged: 0,
        trend: new Map(),
        repositories: new Map(),
      };
      tallies.set(person.key, fresh);
      return fresh;
    };

    for (const row of commits) {
      if (isNotAPerson(this.register, row.email)) continue;
      const person = resolveEngineer(this.register, row.email);
      if (!person) {
        unknownAddresses.add(row.email);
        unattributedCommits += row.commits;
        continue;
      }
      const t = tally(person);
      t.commits += row.commits;
      // Deliberately a max, not a sum: the same repository can appear under two
      // of one person's addresses, and adding them would overstate their reach.
      t.activeRepositories = Math.max(t.activeRepositories, row.repositories);
      if (
        row.lastCommitAt &&
        (!t.lastCommitAt || row.lastCommitAt > t.lastCommitAt)
      ) {
        t.lastCommitAt = row.lastCommitAt;
      }
    }

    for (const row of trend) {
      if (isNotAPerson(this.register, row.email)) continue;
      const person = resolveEngineer(this.register, row.email);
      if (!person) continue;
      const t = tally(person);
      const stamp = row.start.getTime();
      t.trend.set(stamp, (t.trend.get(stamp) ?? 0) + row.commits);
    }

    for (const row of authorRepositories) {
      if (isNotAPerson(this.register, row.email)) continue;
      const person = resolveEngineer(this.register, row.email);
      if (!person) continue;
      const t = tally(person);
      // Summed, not replaced: two addresses for one human contributing to the
      // same repository must add up rather than the second overwriting the
      // first -- the mistake the register exists to prevent.
      t.repositories.set(
        row.slug,
        (t.repositories.get(row.slug) ?? 0) + row.commits,
      );
    }

    const resolveByName = (name: string): RegisteredEngineer | undefined => {
      const person = byName.get(normaliseName(name));
      if (!person) unknownNames.add(name);
      return person;
    };

    for (const row of authored) {
      const person = resolveByName(row.name);
      if (!person) continue;
      const t = tally(person);
      t.created += row.created;
      t.mergedOwn += row.merged;
      if (row.averageMergeHours !== null) {
        // One name per person on this side, so no weighting is needed; if that
        // ever stops being true this becomes a weighted mean.
        t.averageMergeHours = row.averageMergeHours;
      }
    }

    for (const row of participation) {
      const person = resolveByName(row.name);
      if (!person) continue;
      const t = tally(person);
      t.reviewed += row.reviewed;
      t.approved += row.approved;
    }

    for (const row of mergedBy) {
      const person = resolveByName(row.name);
      if (!person) continue;
      tally(person).merged += row.merged;
    }

    if (unknownAddresses.size > 0 || unknownNames.size > 0) {
      this.logger.warn(
        `Productivity: ${unknownAddresses.size} commit address(es) and ` +
          `${unknownNames.size} pull request name(s) are not in the identity ` +
          `register, covering ${unattributedCommits} commits. Add them to ` +
          `catalog/identity-register.yaml`,
      );
    }

    const engineers: EngineerProductivity[] = [...tallies.values()]
      .map(t => ({
        key: t.person.key,
        name: t.person.name,
        email: t.person.email,
        commits: t.commits,
        activeRepositories: t.activeRepositories,
        lastCommitAt: t.lastCommitAt?.toISOString(),
        pullRequestsCreated: t.created,
        pullRequestsMergedOfTheirOwn: t.mergedOwn,
        pullRequestsReviewed: t.reviewed,
        pullRequestsApproved: t.approved,
        pullRequestsMerged: t.merged,
        averageMergeHours:
          t.averageMergeHours === undefined
            ? undefined
            : Math.round(t.averageMergeHours * 10) / 10,
        commitTrend: [...t.trend.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([stamp, n]) => ({
            start: new Date(stamp).toISOString(),
            commits: n,
          })),
        repositories: [...t.repositories.entries()]
          .map(([slug, n]) => ({ slug, commits: n }))
          .sort(
            (a, b) => b.commits - a.commits || a.slug.localeCompare(b.slug),
          ),
      }))
      .sort(
        (a, b) =>
          b.commits - a.commits ||
          b.pullRequestsCreated - a.pullRequestsCreated ||
          a.name.localeCompare(b.name),
      );

    return {
      trendBucket,
      generatedAt: new Date().toISOString(),
      window: {
        since: window.since.toISOString(),
        until: window.until?.toISOString(),
        repositorySlug: window.repositorySlug,
      },
      engineers,
      repositories,
      unattributed: {
        commitAddresses: [...unknownAddresses].sort(),
        pullRequestNames: [...unknownNames].sort(),
        commits: unattributedCommits,
      },
    };
  }
}
