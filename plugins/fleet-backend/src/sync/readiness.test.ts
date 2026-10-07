import type { SyncStateRecord } from '../database/SyncStateStore';
import { hasCompletedOnce, partialFailure } from './readiness';

const T = new Date('2026-09-27T18:00:00.000Z');

function state(overrides: Partial<SyncStateRecord>): SyncStateRecord {
  return {
    resource: 'commits:demandai',
    cursor: null,
    last_attempt_at: T,
    last_success_at: null,
    consecutive_failures: 0,
    last_error: null,
    ...overrides,
  };
}

describe('hasCompletedOnce', () => {
  it('is false for a pass that has never run', () => {
    expect(hasCompletedOnce(undefined, 106)).toBe(false);
  });

  it('is false for a first run still in progress', () => {
    // An attempt with neither a success nor an error: running, or killed.
    expect(hasCompletedOnce(state({}), 106)).toBe(false);
  });

  it('is true once a run has succeeded', () => {
    expect(hasCompletedOnce(state({ last_success_at: T }), 106)).toBe(true);
  });

  it('stays true through later failures, because the facts are still stored', () => {
    expect(
      hasCompletedOnce(
        state({
          last_success_at: T,
          consecutive_failures: 3,
          last_error: 'fetch failed',
        }),
        106,
      ),
    ).toBe(true);
  });

  it('is false for a pass that has only ever crashed outright', () => {
    expect(
      hasCompletedOnce(
        state({ consecutive_failures: 1, last_error: 'fetch failed' }),
        106,
      ),
    ).toBe(false);
  });

  // The case that makes a pass-level "has it succeeded" gate unusable: one
  // permanently broken repository would block scoring for ever.
  it('is true for a run that finished with some repositories failing', () => {
    expect(
      hasCompletedOnce(
        state({
          consecutive_failures: 1,
          last_error: partialFailure(4).message,
        }),
        106,
      ),
    ).toBe(true);
  });

  it('is false when every live repository failed, since nothing was stored', () => {
    expect(
      hasCompletedOnce(
        state({
          consecutive_failures: 1,
          last_error: partialFailure(106).message,
        }),
        106,
      ),
    ).toBe(false);
  });

  it('accepts a size sweep that finished with some pull requests unmeasured', () => {
    expect(
      hasCompletedOnce(
        state({
          consecutive_failures: 1,
          last_error: partialFailure(2, 'pull requests could not be measured')
            .message,
        }),
        106,
      ),
    ).toBe(true);
  });

  it('builds exactly the messages the services have always recorded', () => {
    // Stored sync_state rows written before this module existed must still
    // parse, so the wording is pinned rather than merely round-tripped.
    expect(partialFailure(4).message).toBe('4 repositories failed');
    expect(
      partialFailure(2, 'pull requests could not be measured').message,
    ).toBe('2 pull requests could not be measured');
  });
});
