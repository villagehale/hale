import { describe, expect, it } from 'vitest';
import { type ProbeTextRecord, judgeProbe, percentile, summarizeProbe } from './report';

const counters = {
  runs: 3,
  exhaustedRuns: 0,
  failedRuns: 0,
  turnDbErrors: 0,
  redrivenAfterAnswer: 0,
  enqueueFailures: 0,
  peakConnections: 4,
};

function text(arrived: number, turnMs: number, claimLag: number, extra = 0): ProbeTextRecord {
  return {
    arrivedAtMs: arrived,
    turnMs,
    claimedAtMs: arrived + claimLag,
    answeredAtMs: arrived + claimLag + turnMs + extra,
    answers: 1,
  };
}

describe('percentile', () => {
  it('takes the nearest rank', () => {
    const values = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(percentile(values, 95)).toBe(19);
    expect(percentile(values, 50)).toBe(10);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([], 95)).toBeNull();
  });
});

describe('summarizeProbe and judgeProbe', () => {
  it('passes a run where every text is answered once and the drain adds little', () => {
    const records = Array.from({ length: 20 }, (_, i) => text(i * 1000, 30_000, 400));
    const report = summarizeProbe(records, counters);
    expect(report.drainDelayP95Ms).toBe(400);
    expect(report.answerP95Ms).toBe(30_400);
    expect(judgeProbe(report)).toEqual({ drainPass: true, answerPass: true, misses: [] });
  });

  it('separates the drain’s delay from the turn’s own time', () => {
    // A long turn that was claimed at once is the model's delay, not the drain's.
    const slowTurn = summarizeProbe([text(0, 75_000, 300)], counters);
    expect(judgeProbe(slowTurn)).toEqual({
      drainPass: true,
      answerPass: false,
      misses: ['answer_p95'],
    });
    // A short turn that waited 50 s for a run is the drain's.
    const queued = summarizeProbe([text(0, 5_000, 50_000)], counters);
    expect(queued.drainDelayP95Ms).toBe(50_000);
    expect(judgeProbe(queued).misses).toEqual(['drain_delay_p95']);
    expect(judgeProbe(queued).drainPass).toBe(false);
  });

  it('fails a text nobody answered and a text answered twice', () => {
    const records: ProbeTextRecord[] = [
      text(0, 10_000, 300),
      { arrivedAtMs: 0, turnMs: 10_000, answers: 0 },
      { ...text(0, 10_000, 300), answers: 2 },
    ];
    const report = summarizeProbe(records, counters);
    expect(report.unanswered).toBe(1);
    expect(report.doubleAnswered).toBe(1);
    expect(judgeProbe(report).misses).toEqual(['unanswered', 'double_answered']);
  });

  it('fails an empty run rather than passing it', () => {
    expect(judgeProbe(summarizeProbe([], counters)).misses).toContain('no_texts');
  });
});
