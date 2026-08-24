import type { DatabaseService } from '@backstage/backend-plugin-api';
import type { RepositoryScore, ScoreBreakdownEntry } from '../scoring/types';

type DatabaseClient = Awaited<ReturnType<DatabaseService['getClient']>>;

export interface ScoreRecord {
  id: number;
  repository_id: number;
  computed_at: Date;
  total: number;
  band: string;
  available_weight: number;
  breakdown: ScoreBreakdownEntry[];
}

interface ScoreRow {
  id: number;
  repository_id: number;
  computed_at: Date;
  total: number;
  band: string;
  available_weight: number;
  breakdown: string;
}

function hydrate(row: ScoreRow): ScoreRecord {
  return {
    ...row,
    total: Number(row.total),
    available_weight: Number(row.available_weight),
    breakdown: JSON.parse(row.breakdown),
  };
}

/**
 * Append-only score history.
 *
 * Nothing here updates an existing row: a score is a measurement taken at a
 * moment, and overwriting it destroys the trend that makes the score useful.
 */
export class ScoreStore {
  constructor(private readonly db: DatabaseClient) {}

  async record(
    repositoryId: number,
    score: RepositoryScore,
    computedAt: Date = new Date(),
  ): Promise<void> {
    await this.db('repo_score').insert({
      repository_id: repositoryId,
      computed_at: computedAt,
      total: score.total,
      band: score.band,
      available_weight: score.availableWeight,
      breakdown: JSON.stringify(score.breakdown),
    });
  }

  /** The most recent score, which is what the UI reads. */
  async latest(repositoryId: number): Promise<ScoreRecord | undefined> {
    const row = await this.db<ScoreRow>('repo_score')
      .where({ repository_id: repositoryId })
      .orderBy('computed_at', 'desc')
      .orderBy('id', 'desc')
      .first();
    return row ? hydrate(row) : undefined;
  }

  /**
   * Latest score for each of the given repositories, keyed by repository id.
   *
   * Resolved via the highest row id per repository rather than a window
   * function or LATERAL join, both to stay portable across Postgres and SQLite
   * and because rows are only ever appended in chronological order -- so id
   * order and `computed_at` order agree.
   */
  async latestForRepositories(
    repositoryIds: number[],
  ): Promise<Map<number, ScoreRecord>> {
    if (repositoryIds.length === 0) return new Map();

    const newest = (await this.db('repo_score')
      .whereIn('repository_id', repositoryIds)
      .groupBy('repository_id')
      .max({ id: 'id' })) as Array<{ id: number }>;

    const ids = newest.map(r => Number(r.id)).filter(Boolean);
    if (ids.length === 0) return new Map();

    const rows = await this.db<ScoreRow>('repo_score').whereIn('id', ids);
    return new Map(rows.map(row => [row.repository_id, hydrate(row)]));
  }

  /** Newest first. Used for trends. */
  async history(repositoryId: number, limit = 30): Promise<ScoreRecord[]> {
    const rows = await this.db<ScoreRow>('repo_score')
      .where({ repository_id: repositoryId })
      .orderBy('computed_at', 'desc')
      .orderBy('id', 'desc')
      .limit(limit);
    return rows.map(hydrate);
  }

  async count(repositoryId: number): Promise<number> {
    const row = await this.db('repo_score')
      .where({ repository_id: repositoryId })
      .count({ n: '*' })
      .first();
    return Number((row as any)?.n ?? 0);
  }
}
