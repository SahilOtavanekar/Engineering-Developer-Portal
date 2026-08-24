import type { DatabaseService } from '@backstage/backend-plugin-api';
import type { BitbucketPipelineRun } from '../bitbucket/types';

type DatabaseClient = Awaited<ReturnType<DatabaseService['getClient']>>;

export interface PipelineSummary {
  /** Runs that finished, so have a result worth judging. */
  completed: number;
  successful: number;
  failed: number;
  /** Runs still going, excluded from the rate rather than counted as failures. */
  inProgress: number;
  lastResult?: string;
  lastRunAt?: Date;
}

const SUCCESS = 'SUCCESSFUL';

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

    return {
      completed: completed.length,
      successful,
      failed: completed.length - successful,
      inProgress: rows.length - completed.length,
      lastResult: completed[0]?.result ?? undefined,
      lastRunAt: rows[0] ? new Date(rows[0].created_at) : undefined,
    };
  }
}
