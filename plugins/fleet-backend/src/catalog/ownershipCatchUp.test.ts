import { mockServices } from '@backstage/backend-test-utils';
import { refreshWithOwnershipCatchUp } from './ownershipCatchUp';

/** `ready` answers from a script, one entry per call; the last repeats. */
function scripted(...answers: boolean[]) {
  let calls = 0;
  const ready = async () => answers[Math.min(calls++, answers.length - 1)];
  return { ready, calls: () => calls };
}

function harness() {
  let refreshes = 0;
  const waits: number[] = [];
  return {
    refresh: async () => {
      refreshes++;
    },
    refreshes: () => refreshes,
    waits,
    catchUp: {
      intervalMs: 30_000,
      maxWaitMs: 90_000,
      sleep: async (ms: number) => {
        waits.push(ms);
      },
    },
    logger: mockServices.logger.mock(),
  };
}

describe('refreshWithOwnershipCatchUp', () => {
  it('refreshes once, without waiting, when ownership has already resolved', async () => {
    const h = harness();
    const { ready } = scripted(true);

    await refreshWithOwnershipCatchUp({
      workspace: 'demandai',
      label: 'test',
      refresh: h.refresh,
      ready,
      logger: h.logger,
      catchUp: h.catchUp,
    });

    expect(h.refreshes()).toBe(1);
    expect(h.waits).toEqual([]);
  });

  // The first-boot case: registered before ownership existed, so every
  // component went out as group:default/unowned for a whole 30-minute cycle.
  it('refreshes again as soon as ownership resolves', async () => {
    const h = harness();
    const { ready } = scripted(false, false, true);

    await refreshWithOwnershipCatchUp({
      workspace: 'demandai',
      label: 'test',
      refresh: h.refresh,
      ready,
      logger: h.logger,
      catchUp: h.catchUp,
    });

    expect(h.refreshes()).toBe(2);
    expect(h.waits).toEqual([30_000, 30_000]);
  });

  it('refreshes before it waits, so the catalog is never empty meanwhile', async () => {
    const order: string[] = [];
    const { ready } = scripted(false, true);

    await refreshWithOwnershipCatchUp({
      workspace: 'demandai',
      label: 'test',
      refresh: async () => {
        order.push('refresh');
      },
      ready,
      logger: mockServices.logger.mock(),
      catchUp: {
        intervalMs: 1,
        sleep: async () => {
          order.push('wait');
        },
      },
    });

    expect(order).toEqual(['refresh', 'wait', 'refresh']);
  });

  it('gives up after the limit and leaves it to the next scheduled run', async () => {
    const h = harness();
    const { ready } = scripted(false);

    await refreshWithOwnershipCatchUp({
      workspace: 'demandai',
      label: 'test',
      refresh: h.refresh,
      ready,
      logger: h.logger,
      catchUp: h.catchUp,
    });

    expect(h.refreshes()).toBe(1);
    // 90 seconds at 30-second intervals.
    expect(h.waits).toEqual([30_000, 30_000, 30_000]);
  });

  it('never waits when there is no way to ask', async () => {
    const h = harness();

    await refreshWithOwnershipCatchUp({
      workspace: 'demandai',
      label: 'test',
      refresh: h.refresh,
      logger: h.logger,
      catchUp: h.catchUp,
    });

    expect(h.refreshes()).toBe(1);
    expect(h.waits).toEqual([]);
  });

  it('lets a failed refresh reach the caller, which already handles it', async () => {
    const { ready } = scripted(true);

    await expect(
      refreshWithOwnershipCatchUp({
        workspace: 'demandai',
        label: 'test',
        refresh: async () => {
          throw new Error('Bitbucket unreachable');
        },
        ready,
        logger: mockServices.logger.mock(),
      }),
    ).rejects.toThrow('Bitbucket unreachable');
  });
});
