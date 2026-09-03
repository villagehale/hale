import type { Database } from '@hale/db';
import { describe, expect, it, vi } from 'vitest';
import type { ProviderHealthDeps } from './provider-health';
import {
  RUN_SPIKE_MIN_RUNS,
  RUN_SPIKE_WINDOW_MINUTES,
  type RunStatusCount,
  checkRunFailureSpike,
  summarizeRunFailures,
} from './run-failure-spike';

/**
 * VIL-255 · the backstop. The pre-flight only sees failures the provider ANSWERS with;
 * this catches the rest — a bad deploy, a broken tool, an outage that starts mid-window
 * — by reading the outcome of the window that just closed.
 */

const START = new Date('2026-08-01T12:00:00Z');
const END = new Date('2026-08-01T13:00:00Z');

function summarize(rows: RunStatusCount[]) {
  return summarizeRunFailures(rows, START, END);
}

describe('summarizeRunFailures', () => {
  it('spikes when most finished runs failed', () => {
    const summary = summarize([
      { status: 'failed', count: 7 },
      { status: 'completed', count: 1 },
    ]);

    expect(summary).toEqual({ total: 8, failed: 7, windowStart: START, windowEnd: END, spiked: true });
  });

  it('does NOT spike at exactly half — the rule is MORE than half', () => {
    const summary = summarize([
      { status: 'failed', count: 4 },
      { status: 'completed', count: 4 },
    ]);

    expect(summary.total).toBe(8);
    expect(summary.spiked).toBe(false);
  });

  it('stays quiet below the minimum-runs floor, where one failure is 100%', () => {
    const summary = summarize([{ status: 'failed', count: RUN_SPIKE_MIN_RUNS - 1 }]);

    expect(summary.failed).toBe(RUN_SPIKE_MIN_RUNS - 1);
    expect(summary.spiked).toBe(false);
  });

  it('spikes once the floor is reached and every run failed', () => {
    expect(summarize([{ status: 'failed', count: RUN_SPIKE_MIN_RUNS }]).spiked).toBe(true);
  });

  it('a window of nothing but timeouts is a total outage and MUST spike (the 120s-wall shape)', () => {
    const summary = summarize([{ status: 'timed_out', count: 10 }]);

    expect(summary).toEqual({
      total: 10,
      failed: 10,
      windowStart: START,
      windowEnd: END,
      spiked: true,
    });
  });

  it('counts killed_cost in the numerator AND the denominator', () => {
    const summary = summarize([
      { status: 'killed_cost', count: 3 },
      { status: 'timed_out', count: 2 },
      { status: 'completed', count: 3 },
    ]);

    expect(summary).toEqual({
      total: 8,
      failed: 5,
      windowStart: START,
      windowEnd: END,
      spiked: true,
    });
  });

  it('ignores runs still in progress — a ratio over unfinished work is a guess', () => {
    const summary = summarize([
      { status: 'failed', count: 5 },
      { status: 'completed', count: 1 },
      { status: 'in_progress', count: 40 },
    ]);

    expect(summary.total).toBe(6);
    expect(summary.failed).toBe(5);
    expect(summary.spiked).toBe(true);
  });

  it('reports an idle window honestly rather than as a 0/0 spike', () => {
    expect(summarize([])).toEqual({
      total: 0,
      failed: 0,
      windowStart: START,
      windowEnd: END,
      spiked: false,
    });
  });
});

function fakeDb(rows: RunStatusCount[]): { database: Database; where: ReturnType<typeof vi.fn> } {
  const where = vi.fn(() => ({ groupBy: async () => rows }));
  const database = {
    select: () => ({ from: () => ({ where }) }),
  } as unknown as Database;
  return { database, where };
}

function deps(over: Partial<ProviderHealthDeps> = {}): ProviderHealthDeps {
  return {
    probe: vi.fn(async () => ({ ok: true }) as const),
    claim: vi.fn(async () => true),
    sender: { send: vi.fn(async () => true) },
    ...over,
  };
}

describe('checkRunFailureSpike', () => {
  const NOW = new Date('2026-08-01T13:00:00Z');

  it('reads the window that just closed and pages the founder on a spike', async () => {
    const { database } = fakeDb([
      { status: 'failed', count: 8 },
      { status: 'completed', count: 0 },
    ]);
    const d = deps();

    const result = await checkRunFailureSpike(database, d, NOW);

    expect(result.summary.spiked).toBe(true);
    expect(result.summary.windowStart).toEqual(
      new Date(NOW.getTime() - RUN_SPIKE_WINDOW_MINUTES * 60_000),
    );
    expect(result.summary.windowEnd).toEqual(NOW);
    expect(result.alerted).toBe(true);
    const [subject] = (d.sender.send as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string];
    expect(subject).toContain('8 of 8');
  });

  it('says nothing when the window was healthy', async () => {
    const { database } = fakeDb([{ status: 'completed', count: 8 }]);
    const d = deps();

    const result = await checkRunFailureSpike(database, d, NOW);

    expect(result.summary.spiked).toBe(false);
    expect(result.alerted).toBe(false);
    expect(d.sender.send).not.toHaveBeenCalled();
  });
});
