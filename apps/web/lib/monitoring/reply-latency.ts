import { percentileNearestRank } from '~/lib/loop/funnel-scoreboard';

/**
 * How long a parent waited for Hale, read from the turn ledger (VIL-409).
 *
 * An inbound is answered when its `sms_turn_answered` row exists. Outbound rows of
 * category `reply` are never paired with it: nudges, polls, upgrade asks and connect
 * notices write that category too, so pairing on it would call a nudge an answer.
 */
export interface InboundTurnRow {
  inboundAt: Date;
  answeredAt: Date | null;
  inGroup: boolean;
}

export interface ReplyLatencyStat {
  inbound: number;
  answered: number;
  p50Seconds: number | null;
  p95Seconds: number | null;
  maxSeconds: number | null;
  gaps: number;
  pending: number;
  groupInbound: number;
  groupAnswered: number;
}

/**
 * p50/p95/max and gaps are over 1:1 inbounds only. A group inbound may be left
 * unanswered on purpose, so it is counted and never called a gap. Unanswered after
 * `gapAfterMs` is a gap; younger is pending. An answer recorded before its inbound
 * is impossible and throws.
 */
export function computeReplyLatency(
  rows: InboundTurnRow[],
  windowEnd: Date,
  gapAfterMs: number,
): ReplyLatencyStat {
  const latencies: number[] = [];
  let inbound = 0;
  let gaps = 0;
  let pending = 0;
  let groupInbound = 0;
  let groupAnswered = 0;

  for (const row of rows) {
    if (row.answeredAt && row.answeredAt < row.inboundAt) {
      throw new Error('computeReplyLatency: an answer is recorded before its inbound');
    }
    if (row.inGroup) {
      groupInbound += 1;
      if (row.answeredAt) groupAnswered += 1;
      continue;
    }
    inbound += 1;
    if (row.answeredAt) {
      latencies.push(Math.round((row.answeredAt.getTime() - row.inboundAt.getTime()) / 1000));
    } else if (windowEnd.getTime() - row.inboundAt.getTime() >= gapAfterMs) {
      gaps += 1;
    } else {
      pending += 1;
    }
  }

  return {
    inbound,
    answered: latencies.length,
    p50Seconds: percentileNearestRank(latencies, 0.5),
    p95Seconds: percentileNearestRank(latencies, 0.95),
    maxSeconds: percentileNearestRank(latencies, 1),
    gaps,
    pending,
    groupInbound,
    groupAnswered,
  };
}
