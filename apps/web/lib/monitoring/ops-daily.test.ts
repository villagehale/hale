import { describe, expect, it } from 'vitest';
import type { Database } from '@hale/db';
import { TURN_ANSWERED_ACTION, auditTurnLedger } from '~/lib/channel/router/wiring';
import { SYNTHETIC_PROBE_PREFIX } from '~/lib/channels/phone';
import {
  TURN_ANSWERED_AUDIT_ACTION,
  TURN_UNANSWERED_AUDIT_ACTION,
  composeOpsDailyPost,
  type OpsDailyReport,
} from './ops-daily';

/**
 * The #ops daily post's text (VIL-409). Both expected strings are written from the
 * brief's format (ASCII separators), not copied from the composer's output.
 */

const WINDOW = {
  start: new Date('2026-10-11T13:00:00Z'),
  end: new Date('2026-10-12T13:00:00Z'),
};

const SAMPLE: OpsDailyReport = {
  window: WINDOW,
  families: { real: 7, excluded: 3 },
  replies: {
    inbound: 142,
    answered: 141,
    p50Seconds: 9,
    p95Seconds: 41,
    maxSeconds: 192,
    gaps: 1,
    pending: 0,
    groupInbound: 12,
    groupAnswered: 5,
  },
  unanswered: [
    { reason: 'turn_timeout', count: 1 },
    { reason: 'gate_timeout', count: 2 },
  ],
  sends: { attempted: 160, failed: 3, codes: [{ code: 'carrier_rejected', count: 2 }] },
  held: [{ reason: 'suppressed_quiet_hours', count: 4 }],
  turns: {
    failed: [{ reason: 'apology_sent', count: 1 }],
    deferred: 4,
    providerDeferred: { billing: 0, auth: 0 },
    deadLettered: 0,
    firstHelloFailures: 0,
  },
  cache: [
    {
      agentName: 'coach-channel-sms',
      runs: 40,
      hitRuns: 34,
      tokenRate: 0.71,
      tokenRuns: 40,
      latencyP95Ms: 6200,
    },
  ],
  spend: { totalUsd: 4.12, families: 6, medianUsd: 0.51, p95Usd: 1.3, maxUsd: 1.42 },
};

const ZERO: OpsDailyReport = {
  window: WINDOW,
  families: { real: 0, excluded: 0 },
  replies: {
    inbound: 0,
    answered: 0,
    p50Seconds: null,
    p95Seconds: null,
    maxSeconds: null,
    gaps: 0,
    pending: 0,
    groupInbound: 0,
    groupAnswered: 0,
  },
  unanswered: [],
  sends: { attempted: 0, failed: 0, codes: [] },
  held: [],
  turns: {
    failed: [],
    deferred: 0,
    providerDeferred: { billing: 0, auth: 0 },
    deadLettered: 0,
    firstHelloFailures: 0,
  },
  cache: [],
  spend: { totalUsd: 0, families: 0, medianUsd: null, p95Usd: null, maxUsd: null },
};

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const LONG_DIGITS = /\d{7,}/;
const NON_ASCII = /[^ -~\n]/;

describe('composeOpsDailyPost', () => {
  it('renders a day of traffic as eight ASCII lines of counts', () => {
    expect(composeOpsDailyPost(SAMPLE)).toBe(
      [
        'Hale daily | 24h to 2026-10-12 13:00 UTC | real families 7 | excluded 3',
        'Replies (1:1): 142 in | p50 9s | p95 41s | max 3m12s | gaps>15m 1 | pending 0 | group 12 in / 5 answered',
        'Unanswered steps: turn_timeout 1, gate_timeout 2',
        'Sends: 3 failed of 160 | codes: carrier_rejected x2',
        'Held: suppressed_quiet_hours 4',
        'Turns: failed 1 (apology_sent 1) | deferred 4 (billing 0, auth 0) | dead-lettered 0 | first-hello failures 0',
        'Cache: coach-channel-sms 34/40 runs, tokens 71% (40 runs), p95 6.2s',
        'Spend (recorded runs): $4.12 | 6 families | median $0.51 | p95 $1.30 | max $1.42',
      ].join('\n'),
    );
  });

  it('still posts on a day with no families, so silence never reads as an outage', () => {
    expect(composeOpsDailyPost(ZERO)).toBe(
      [
        'Hale daily | 24h to 2026-10-12 13:00 UTC | real families 0 | excluded 0',
        'Replies (1:1): 0 in | p50 n/a | p95 n/a | max n/a | gaps>15m 0 | pending 0 | group 0 in / 0 answered',
        'Unanswered steps: none',
        'Sends: 0 failed of 0',
        'Held: none',
        'Turns: failed 0 | deferred 0 (billing 0, auth 0) | dead-lettered 0 | first-hello failures 0',
        'Cache: none',
        'Spend (recorded runs): $0.00 | 0 families',
      ].join('\n'),
    );
  });

  it('carries no id-shaped or phone-shaped token and no non-ASCII character', () => {
    // Positive control: the regexes do catch what they are for.
    expect(UUID.test('0b7c9a52-3f1e-4d8a-9c2b-5e6f7a8b9c0d')).toBe(true);
    expect(LONG_DIGITS.test(`${SYNTHETIC_PROBE_PREFIX}0100`)).toBe(true);
    expect(NON_ASCII.test('a · b')).toBe(true);

    for (const report of [SAMPLE, ZERO]) {
      const text = composeOpsDailyPost(report);
      expect(text).not.toMatch(UUID);
      expect(text).not.toMatch(LONG_DIGITS);
      expect(text).not.toMatch(NON_ASCII);
    }
  });

  it('redacts a reason or a code that carries a phone-length digit run', () => {
    const text = composeOpsDailyPost({
      ...SAMPLE,
      unanswered: [{ reason: 'stalled_14375550100', count: 1 }],
      turns: { ...SAMPLE.turns, failed: [{ reason: 'call 12345678 back', count: 1 }] },
      sends: { attempted: 1, failed: 1, codes: [{ code: 'refused_123456789', count: 1 }] },
    });
    expect(text).toContain('Unanswered steps: redacted 1');
    expect(text).toContain('failed 1 (redacted 1)');
    expect(text).toContain('codes: refused_123456 x1');
    expect(text).not.toMatch(LONG_DIGITS);
  });
});

describe('the turn-ledger spellings the digest reads', () => {
  it('match what the router writes', async () => {
    expect(TURN_ANSWERED_AUDIT_ACTION).toBe(TURN_ANSWERED_ACTION);

    const written: Array<Record<string, unknown>> = [];
    const capture = {
      insert: () => ({
        values: async (row: Record<string, unknown>) => {
          written.push(row);
        },
      }),
    } as unknown as Database;
    await auditTurnLedger(capture).recordUnanswered({
      familyId: 'family',
      parentUserId: 'parent',
      channelMessageId: 'message',
      reason: 'turn_timeout',
    });
    expect(written.map((row) => row.actionTaken)).toEqual([TURN_UNANSWERED_AUDIT_ACTION]);
  });
});
