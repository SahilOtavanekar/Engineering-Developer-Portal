/**
 * Keeps the passes of one refresh cycle in dependency order.
 *
 * **Why this exists.** Every pass runs on its own timer, and timers drift: by
 * 2026-10-08 the local backend ran scoring *before* the commit and pull request
 * passes in every cycle, so each score was computed from the previous cycle's
 * facts. On a 30-minute cycle that cost at most half an hour. On the 6-hour
 * cycle chosen that day it would put scores up to 6 hours behind the data they
 * claim to describe, on top of the 6 hours between refreshes.
 *
 * So a dependent pass (branch policy, scoring) is **woken** when an input
 * finishes, and **runs only once every input has finished since it last
 * started** -- once per cycle, after the last of its inputs. Its own timer
 * stays as a fallback; the same rule makes that a no-op when the chain has
 * already run it.
 *
 * **In memory, deliberately.** `sync_state` cannot say when a pass *finished*:
 * `recordSuccess` and `recordFailure` write the start time back as
 * `last_attempt_at`. Finish times are therefore tracked here, per process. The
 * chart runs one replica. After a restart a dependent counts as having started
 * when the process did, so it waits for this cycle's inputs like any other:
 * counting it as never started let the first input to finish -- commits --
 * wake scoring before branch policy had run, an extra score row from stale
 * classifications.
 *
 * **Never starves.** If an input stops finishing -- backing off after repeated
 * failures, say -- the dependent still runs once `maxWaitMs` has passed since
 * it last started, on whatever facts are stored, exactly as it did before.
 */
export class PassCycle {
  private readonly startedAt = new Map<string, number>();
  private readonly finishedAt = new Map<string, number>();
  private readonly bootedAt: number;

  constructor(private readonly now: () => number = Date.now) {
    this.bootedAt = now();
  }

  started(resource: string): void {
    this.startedAt.set(resource, this.now());
  }

  finished(resource: string): void {
    this.finishedAt.set(resource, this.now());
  }

  /**
   * Whether `resource` should run now, given the passes it reads.
   *
   * True when every input has finished since it last started -- or since the
   * process started, if it has not run yet -- or when it has waited
   * `maxWaitMs` since then.
   */
  due(resource: string, inputs: string[], maxWaitMs: number): boolean {
    const lastStart = this.startedAt.get(resource) ?? this.bootedAt;
    if (this.now() - lastStart >= maxWaitMs) return true;
    return inputs.every(
      input => (this.finishedAt.get(input) ?? -1) > lastStart,
    );
  }

  /** The inputs that have not finished since `resource` last started. */
  pending(resource: string, inputs: string[]): string[] {
    const lastStart = this.startedAt.get(resource) ?? this.bootedAt;
    return inputs.filter(
      input => (this.finishedAt.get(input) ?? -1) <= lastStart,
    );
  }
}

type Frequency =
  | {
      years?: number;
      months?: number;
      weeks?: number;
      days?: number;
      hours?: number;
      minutes?: number;
      seconds?: number;
      milliseconds?: number;
    }
  | { cron: string }
  | { trigger: 'manual' };

/**
 * A schedule's frequency in milliseconds, or `fallbackMs` for a cron or
 * manual schedule, which has no fixed interval to measure.
 */
export function frequencyMs(frequency: Frequency, fallbackMs: number): number {
  if ('cron' in frequency || 'trigger' in frequency) return fallbackMs;
  const d = frequency;
  const ms =
    (d.years ?? 0) * 365 * 86_400_000 +
    (d.months ?? 0) * 30 * 86_400_000 +
    (d.weeks ?? 0) * 7 * 86_400_000 +
    (d.days ?? 0) * 86_400_000 +
    (d.hours ?? 0) * 3_600_000 +
    (d.minutes ?? 0) * 60_000 +
    (d.seconds ?? 0) * 1_000 +
    (d.milliseconds ?? 0);
  return ms > 0 ? ms : fallbackMs;
}
