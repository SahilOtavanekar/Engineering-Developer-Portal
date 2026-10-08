import { PassCycle, frequencyMs } from './cycle';

const HOUR = 3_600_000;

function clock(start = 0) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('PassCycle', () => {
  const inputs = ['branch-policy', 'repository-detail'];

  it('after a restart, waits for the inputs of this cycle rather than running at once', () => {
    // Counting it as never started let the first input to finish (commits)
    // wake scoring before branch policy ran: an extra row from stale facts.
    const c = clock();
    const cycle = new PassCycle(c.now);
    expect(cycle.due('scoring', inputs, 12 * HOUR)).toBe(false);
    c.advance(1000);
    cycle.finished('branch-policy');
    expect(cycle.due('scoring', inputs, 12 * HOUR)).toBe(false);
    cycle.finished('repository-detail');
    expect(cycle.due('scoring', inputs, 12 * HOUR)).toBe(true);
  });

  it('after a restart, still runs once it has waited the maximum', () => {
    const c = clock();
    const cycle = new PassCycle(c.now);
    c.advance(12 * HOUR);
    expect(cycle.due('scoring', inputs, 12 * HOUR)).toBe(true);
  });

  it('holds a pass until every input has finished since it last started', () => {
    const c = clock();
    const cycle = new PassCycle(c.now);
    cycle.started('scoring');
    c.advance(1000);
    cycle.finished('branch-policy');
    expect(cycle.due('scoring', inputs, 12 * HOUR)).toBe(false);
    expect(cycle.pending('scoring', inputs)).toEqual(['repository-detail']);
    c.advance(1000);
    cycle.finished('repository-detail');
    expect(cycle.due('scoring', inputs, 12 * HOUR)).toBe(true);
  });

  it('runs a pass once per cycle, not again on its own timer', () => {
    const c = clock();
    const cycle = new PassCycle(c.now);
    cycle.finished('branch-policy');
    cycle.finished('repository-detail');
    c.advance(1000);
    cycle.started('scoring'); // woken by the last input
    c.advance(60_000);
    // Its own timer fires later in the same cycle: nothing new to score.
    expect(cycle.due('scoring', inputs, 12 * HOUR)).toBe(false);
  });

  it('does not count an input that finished before the pass last started', () => {
    const c = clock();
    const cycle = new PassCycle(c.now);
    cycle.finished('branch-policy');
    cycle.finished('repository-detail');
    c.advance(1000);
    cycle.started('scoring');
    expect(cycle.due('scoring', inputs, 12 * HOUR)).toBe(false);
  });

  it('never starves: runs anyway once it has waited the maximum', () => {
    // An input backing off after repeated failures never finishes, and the
    // dependent must still run on what is stored, as it always did.
    const c = clock();
    const cycle = new PassCycle(c.now);
    cycle.started('scoring');
    c.advance(1000);
    cycle.finished('branch-policy');
    c.advance(12 * HOUR);
    expect(cycle.due('scoring', inputs, 12 * HOUR)).toBe(true);
  });
});

describe('frequencyMs', () => {
  it('measures a duration', () => {
    expect(frequencyMs({ hours: 6 }, 1)).toBe(6 * HOUR);
    expect(frequencyMs({ minutes: 30 }, 1)).toBe(30 * 60_000);
    expect(frequencyMs({ hours: 1, minutes: 30 }, 1)).toBe(1.5 * HOUR);
  });

  it('falls back for a schedule with no fixed interval', () => {
    expect(frequencyMs({ cron: '0 6 * * *' }, 24 * HOUR)).toBe(24 * HOUR);
    expect(frequencyMs({ trigger: 'manual' }, 24 * HOUR)).toBe(24 * HOUR);
    expect(frequencyMs({}, 24 * HOUR)).toBe(24 * HOUR);
  });
});
