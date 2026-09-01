import type { DatabaseService } from '@backstage/backend-plugin-api';
import type { BitbucketPipelineRun } from '../bitbucket/types';

type DatabaseClient = Awaited<ReturnType<DatabaseService['getClient']>>;

/**
 * The four states section 6 asks to see, plus the totals behind them.
 *
 * Bitbucket's vocabulary maps onto the document's like this:
 *
 * | Document  | Bitbucket            |
 * | --------- | -------------------- |
 * | Success   | `SUCCESSFUL`         |
 * | Failed    | `FAILED`, `ERROR`    |
 * | Running   | no result yet        |
 * | Cancelled | `STOPPED`, `EXPIRED` |
 */
export interface PipelineSummary {
  /** Runs that finished, whatever the outcome. */
  completed: number;
  successful: number;
  failed: number;
  /**
   * Runs somebody stopped, or that expired waiting.
   *
   * Kept apart from `failed` and excluded from the success rate: a build a
   * human cancelled says nothing about whether the code builds, and counting
   * it as a failure understates the health of every repository that cancels
   * superseded builds. 27 of this estate's 637 finished runs are in this state.
   */
  cancelled: number;
  /** Runs still going, excluded from the rate rather than counted as failures. */
  inProgress: number;
  /**
   * Runs the success rate is actually computed over: successful plus failed.
   * Reported so the denominator is never a mystery.
   */
  judged: number;
  lastResult?: string;
  lastRunAt?: Date;
}

const SUCCESS = 'SUCCESSFUL';

/** Neither a pass nor a failure -- nobody let the build finish. */
const CANCELLED = new Set(['STOPPED', 'EXPIRED']);

/** Snapshot of recent runs, replaced per repository on each pass. */
export class PipelineStore {
  constructor(private readonly db: DatabaseClient) {}

  async replaceForRepository(
    repositoryId: number,
    runs: BitbucketPipelineRun[],
  ): Promise<number> {
    await this.db('pipeline_run')
      .where({ repository_id: repositoryId })
      .delete();
    if (runs.length === 0) return 0;

    const rows = runs.map(run => ({
      repository_id: repositoryId,
      uuid: run.uuid,
      build_number: run.buildNumber ?? null,
      state: run.state,
      result: run.result ?? null,
      ref_name: run.refName ?? null,
      created_at: new Date(run.createdAt),
      duration_seconds: run.durationSeconds ?? null,
    }));

    for (let i = 0; i < rows.length; i += 200) {
      await this.db('pipeline_run').insert(rows.slice(i, i + 200));
    }
    return rows.length;
  }

  async summary(repositoryId: number): Promise<PipelineSummary> {
    const rows = (await this.db('pipeline_run')
      .where({ repository_id: repositoryId })
      .orderBy('created_at', 'desc')
      .select('state', 'result', 'created_at')) as Array<{
      state: string;
      result: string | null;
      created_at: Date;
    }>;

    const completed = rows.filter(r => r.result);
    const successful = completed.filter(r => r.result === SUCCESS).length;
    const cancelled = completed.filter(
      r => r.result && CANCELLED.has(r.result),
    ).length;

    return {
      completed: completed.length,
      successful,
      // Everything that finished and was neither a pass nor a cancellation.
      // Derived by subtraction rather than by listing failure results, so a
      // result Bitbucket adds later is treated as a failure and investigated
      // rather than silently ignored.
      failed: completed.length - successful - cancelled,
      cancelled,
      inProgress: rows.length - completed.length,
      judged: completed.length - cancelled,
      lastResult: completed[0]?.result ?? undefined,
      lastRunAt: rows[0] ? new Date(rows[0].created_at) : undefined,
    };
  }

  /**
   * The most recent pipeline run per repository, for the whole estate.
   *
   * Batched deliberately: the fleet overview orders by this, and calling
   * `summary()` per repository would be an N+1 in the one endpoint the
   * two-second page load depends on. `pipeline_run` is indexed on
   * `(repository_id, created_at)`, so the grouped max is served from the index.
   *
   * A repository absent from the returned map has no runs at all, which is
   * half this estate -- 47 of 96 -- and is not the same as a run that failed.
   */
  async lastRunForRepositories(
    repositoryIds: number[],
  ): Promise<Map<number, Date>> {
    if (repositoryIds.length === 0) return new Map();

    const rows = (await this.db('pipeline_run')
      .whereIn('repository_id', repositoryIds)
      .groupBy('repository_id')
      .max({ last_run: 'created_at' })
      .select('repository_id')) as Array<{
      repository_id: number;
      last_run: Date | string | null;
    }>;

    return new Map(
      rows
        .filter(row => row.last_run !== null)
        .map(row => [Number(row.repository_id), new Date(row.last_run!)]),
    );
  }
}
