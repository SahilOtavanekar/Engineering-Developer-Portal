import type { DatabaseService } from '@backstage/backend-plugin-api';

type DatabaseClient = Awaited<ReturnType<DatabaseService['getClient']>>;

export interface SyncStateRecord {
  resource: string;
  cursor: string | null;
  last_attempt_at: Date | null;
  last_success_at: Date | null;
  consecutive_failures: number;
  last_error: string | null;
}

/**
 * Tracks synchronisation progress per resource.
 *
 * This is where three of the document's reliability requirements actually
 * live: retry (via `consecutive_failures`, which backoff reads), incremental
 * synchronisation (via `cursor`), and a durable record of whether the last
 * attempt worked.
 */
export class SyncStateStore {
  constructor(private readonly db: DatabaseClient) {}

  async get(resource: string): Promise<SyncStateRecord | undefined> {
    return this.db<SyncStateRecord>('sync_state').where({ resource }).first();
  }

  async recordAttempt(resource: string, now: Date = new Date()): Promise<void> {
    await this.db('sync_state')
      .insert({ resource, last_attempt_at: now, consecutive_failures: 0 })
      .onConflict('resource')
      .merge(['last_attempt_at']);
  }

  async recordSuccess(
    resource: string,
    options: { cursor?: string; now?: Date } = {},
  ): Promise<void> {
    const now = options.now ?? new Date();
    await this.db('sync_state')
      .insert({
        resource,
        cursor: options.cursor ?? null,
        last_attempt_at: now,
        last_success_at: now,
        consecutive_failures: 0,
        last_error: null,
      })
      .onConflict('resource')
      .merge([
        'cursor',
        'last_attempt_at',
        'last_success_at',
        'consecutive_failures',
        'last_error',
      ]);
  }

  async recordFailure(
    resource: string,
    error: Error,
    now: Date = new Date(),
  ): Promise<void> {
    const existing = await this.get(resource);
    const failures = (existing?.consecutive_failures ?? 0) + 1;
    const message = error.message.slice(0, 2000);

    await this.db('sync_state')
      .insert({
        resource,
        last_attempt_at: now,
        consecutive_failures: failures,
        last_error: message,
      })
      .onConflict('resource')
      .merge(['last_attempt_at', 'consecutive_failures', 'last_error']);
  }
}
