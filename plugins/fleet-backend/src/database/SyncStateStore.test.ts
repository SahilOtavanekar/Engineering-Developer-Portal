import {
  startFleetTestDatabase,
  type FleetTestDatabase,
} from '../__testUtils__/database';
import { SyncStateStore } from './SyncStateStore';

const T1 = new Date('2026-08-21T09:00:00.000Z');
const T2 = new Date('2026-08-21T10:00:00.000Z');

describe('SyncStateStore', () => {
  let db: FleetTestDatabase;
  let store: SyncStateStore;

  beforeAll(async () => {
    db = await startFleetTestDatabase();
    store = new SyncStateStore(db.client);
  });

  afterAll(async () => {
    await db?.stop();
  });

  afterEach(async () => {
    await db.client('sync_state').delete();
  });

  it('has no state for a resource never synced', async () => {
    await expect(store.get('repositories:demandai')).resolves.toBeUndefined();
  });

  it('records an attempt before the work is done', async () => {
    await store.recordAttempt('repositories:demandai', T1);

    const state = await store.get('repositories:demandai');

    expect(new Date(state!.last_attempt_at!).toISOString()).toBe(
      T1.toISOString(),
    );
    expect(state!.last_success_at).toBeNull();
  });

  it('records success with a cursor for the next incremental run', async () => {
    await store.recordSuccess('repositories:demandai', {
      cursor: '2026-08-21T09:00:00.000Z',
      now: T1,
    });

    const state = await store.get('repositories:demandai');

    expect(state!.cursor).toBe('2026-08-21T09:00:00.000Z');
    expect(new Date(state!.last_success_at!).toISOString()).toBe(
      T1.toISOString(),
    );
    expect(state!.consecutive_failures).toBe(0);
  });

  it('counts consecutive failures so backoff has something to read', async () => {
    await store.recordFailure('repositories:demandai', new Error('boom'), T1);
    await store.recordFailure('repositories:demandai', new Error('boom'), T2);

    const state = await store.get('repositories:demandai');

    expect(Number(state!.consecutive_failures)).toBe(2);
    expect(state!.last_error).toBe('boom');
  });

  it('resets the failure count once a run succeeds', async () => {
    await store.recordFailure('repositories:demandai', new Error('boom'), T1);
    await store.recordSuccess('repositories:demandai', { now: T2 });

    const state = await store.get('repositories:demandai');

    expect(Number(state!.consecutive_failures)).toBe(0);
    expect(state!.last_error).toBeNull();
  });

  it('does not lose the last success when a later run fails', async () => {
    await store.recordSuccess('repositories:demandai', { now: T1 });
    await store.recordFailure('repositories:demandai', new Error('boom'), T2);

    const state = await store.get('repositories:demandai');

    expect(new Date(state!.last_success_at!).toISOString()).toBe(
      T1.toISOString(),
    );
    expect(Number(state!.consecutive_failures)).toBe(1);
  });

  it('truncates a very long error rather than failing to record it', async () => {
    await store.recordFailure(
      'repositories:demandai',
      new Error('x'.repeat(5000)),
      T1,
    );

    const state = await store.get('repositories:demandai');

    expect(state!.last_error!.length).toBe(2000);
  });

  it('keeps resources independent', async () => {
    await store.recordSuccess('repositories:demandai', { now: T1 });
    await store.recordFailure('repositories:other', new Error('boom'), T1);

    const ok = await store.get('repositories:demandai');
    const bad = await store.get('repositories:other');

    expect(Number(ok!.consecutive_failures)).toBe(0);
    expect(Number(bad!.consecutive_failures)).toBe(1);
  });
});
