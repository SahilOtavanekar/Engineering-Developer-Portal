import type { LoggerService } from '@backstage/backend-plugin-api';
import type { BitbucketClient } from '../bitbucket/types';
import type {
  PullRequestStore,
  RecordedSize,
} from '../database/PullRequestStore';
import type { SyncStateStore } from '../database/SyncStateStore';
import { summariseDiffstat } from './diffstat';

export interface PullRequestSizeServiceOptions {
  client: BitbucketClient;
  pullRequests: PullRequestStore;
  syncState: SyncStateStore;
  logger: LoggerService;
  /**
   * Requests one sweep may spend. Defaults to 400, which clears this estate's
   * ~389 unmeasured pull requests in a single pass.
   */
  requestBudget?: number;
  /** Paths whose lines are not counted. Defaults to the built-in list. */
  generatedPaths?: string[];
}

export interface PullRequestSizeSummary {
  measured: number;
  failures: number;
  /** Still waiting after this sweep, so the log says whether it finished. */
  remaining: number;
  requests: number;
}

/**
 * The default is deliberately larger than the estate needs, so the first sweep
 * finishes rather than leaving the metric partly measured across four passes --
 * a half-measured metric scores a repository on whichever of its pull requests
 * happened to be reached first, which is worse than not scoring it.
 */
const DEFAULT_REQUEST_BUDGET = 400;

/**
 * Measured pull requests written per statement batch.
 *
 * Small enough that a task timeout loses almost nothing and large enough that
 * the writes are not the cost. Measured on the first live sweep: 390 requests
 * took over 16 minutes, so a sweep really can meet its timeout and the work
 * done so far has to survive it.
 */
const WRITE_BATCH = 25;

/**
 * Measures how big merged pull requests are.
 *
 * **The only pass that costs a request per pull request**, which is why it has
 * a budget at all: every other sweep is per repository. Probed against the live
 * API before it was built -- the pull request list carries no diffstat under any
 * spelling, so there is no cheaper route, and `pagelen=500` covers even a
 * 158-file diff in one request.
 *
 * Runs on its own schedule and claims work by finding merged pull requests with
 * no diffstat stored, newest first. A merged pull request is immutable, so a
 * measured row is never refetched and steady-state cost is only the pull
 * requests merged since the last sweep -- a handful.
 */
export class PullRequestSizeService {
  private readonly client: BitbucketClient;
  private readonly pullRequests: PullRequestStore;
  private readonly syncState: SyncStateStore;
  private readonly logger: LoggerService;
  private readonly requestBudget: number;
  private readonly generatedPaths?: string[];

  constructor(options: PullRequestSizeServiceOptions) {
    this.client = options.client;
    this.pullRequests = options.pullRequests;
    this.syncState = options.syncState;
    this.logger = options.logger;
    this.requestBudget = Math.max(
      1,
      options.requestBudget ?? DEFAULT_REQUEST_BUDGET,
    );
    this.generatedPaths = options.generatedPaths;
  }

  static resourceKey(workspace: string): string {
    return `pull-request-size:${workspace}`;
  }

  async measure(
    workspace: string,
    now: Date = new Date(),
  ): Promise<PullRequestSizeSummary> {
    const resource = PullRequestSizeService.resourceKey(workspace);
    await this.syncState.recordAttempt(resource, now);

    let measured = 0;
    let failures = 0;
    let requests = 0;

    try {
      const pending = await this.pullRequests.pendingSizes(
        workspace,
        this.requestBudget,
      );

      if (pending.length === 0) {
        await this.syncState.recordSuccess(resource, {
          cursor: now.toISOString(),
          now,
        });
        return { measured: 0, failures: 0, remaining: 0, requests: 0 };
      }

      // **Written as it goes, in batches, not once at the end.** The first
      // sweep of this estate is 390 sequential requests and took over 16
      // minutes against a 20-minute task timeout; collecting everything and
      // writing at the close meant a timeout threw away every request it had
      // already paid for, and the next sweep would pay for them again. A batch
      // caps that loss at `WRITE_BATCH` pull requests.
      let batch: RecordedSize[] = [];
      const flush = async () => {
        if (batch.length === 0) return;
        measured += await this.pullRequests.recordSizes(batch);
        batch = [];
      };

      for (const row of pending) {
        try {
          const files = await this.client.listPullRequestDiffstat(
            row.workspace,
            row.slug,
            row.prId,
          );
          requests++;

          // An empty diffstat is a real answer, not a failure: `oxp-backend#112`
          // is merged and changed nothing. Storing zeroes is what stops it being
          // refetched on every sweep for ever.
          const summary = summariseDiffstat(files, {
            generatedPaths: this.generatedPaths,
          });
          batch.push({ id: row.id, ...summary });
          if (batch.length >= WRITE_BATCH) await flush();
        } catch (error) {
          failures++;
          this.logger.warn(
            `Could not measure ${row.workspace}/${row.slug}#${row.prId}: ${
              (error as Error).message
            }`,
          );
        }
      }
      await flush();

      const remaining = await this.pullRequests.pendingSizeCount(workspace);

      if (failures === 0) {
        await this.syncState.recordSuccess(resource, {
          cursor: now.toISOString(),
          now,
        });
      } else {
        await this.syncState.recordFailure(
          resource,
          new Error(`${failures} pull requests could not be measured`),
          now,
        );
      }

      this.logger.info(
        `Measured ${measured} pull request${measured === 1 ? '' : 's'} in ` +
          `'${workspace}' using ${requests} request${
            requests === 1 ? '' : 's'
          }; ${remaining} still unmeasured`,
      );
      return { measured, failures, remaining, requests };
    } catch (error) {
      await this.syncState.recordFailure(resource, error as Error, now);
      throw error;
    }
  }
}
