import { describe, expect, it } from 'vitest';
import { type InboundTurnRow, computeReplyLatency } from './reply-latency';

const T = new Date('2026-03-02T10:00:00Z');
const at = (seconds: number) => new Date(T.getTime() + seconds * 1000);
const GAP_MS = 15 * 60_000;

function oneToOne(inboundAt: Date, answeredAt: Date | null): InboundTurnRow {
  return { inboundAt, answeredAt, inGroup: false };
}

describe('computeReplyLatency', () => {
  it('measures each answered 1:1 inbound to its own answer', () => {
    const stat = computeReplyLatency(
      [oneToOne(at(0), at(30)), oneToOne(at(10), at(40))],
      at(3600),
      GAP_MS,
    );
    expect(stat).toEqual({
      inbound: 2,
      answered: 2,
      p50Seconds: 30,
      p95Seconds: 30,
      maxSeconds: 30,
      gaps: 0,
      pending: 0,
      groupInbound: 0,
      groupAnswered: 0,
    });
  });

  it('calls an unanswered inbound pending inside the gap window and a gap after it', () => {
    const tenMinutesOld = computeReplyLatency([oneToOne(at(0), null)], at(10 * 60), GAP_MS);
    expect(tenMinutesOld.pending).toBe(1);
    expect(tenMinutesOld.gaps).toBe(0);

    const twentyMinutesOld = computeReplyLatency([oneToOne(at(0), null)], at(20 * 60), GAP_MS);
    expect(twentyMinutesOld.pending).toBe(0);
    expect(twentyMinutesOld.gaps).toBe(1);
  });

  it('counts a group inbound left unanswered without calling it a gap', () => {
    const stat = computeReplyLatency(
      [{ inboundAt: at(0), answeredAt: null, inGroup: true }],
      at(3600),
      GAP_MS,
    );
    expect(stat.groupInbound).toBe(1);
    expect(stat.groupAnswered).toBe(0);
    expect(stat.gaps).toBe(0);
    expect(stat.inbound).toBe(0);
    expect(stat.p95Seconds).toBeNull();
  });

  it('refuses an answer recorded before its inbound', () => {
    expect(() => computeReplyLatency([oneToOne(at(30), at(0))], at(3600), GAP_MS)).toThrow(
      /before/,
    );
  });
});
