import type { Database } from '@hale/db';
import { describe, expect, it } from 'vitest';
import { TURN_ANSWERED_ACTION, auditTurnLedger } from '~/lib/channel/router/wiring';
import { SYNTHETIC_PROBE_PREFIX } from '~/lib/channels/phone';
import {
  type OpsDailyReport,
  TURN_ANSWERED_AUDIT_ACTION,
  TURN_UNANSWERED_AUDIT_ACTION,
  composeOpsDailyPost,
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
  w4: { retained: 3, families: 8 },
  intake: {
    started: 5,
    provisioned: 4,
    medianSeconds: 75,
    derivedFamilies: 4,
    notDerivableFamilies: 0,
  },
  promises: { open: 6, overdue: 2, overdueFamilies: 1 },
  medical: { answered: 4, fallbacks: 1 },
  reverify: {
    ran: true,
    outcomes: { checked: 20, confirmed: 17, discrepancies: 1, unverified: 2 },
  },
  week: {
    plansComposed: 6,
    providerIncidents: [{ reason: 'billing', count: 1 }],
    unmetIntents: [
      { reason: 'capability_booking', count: 3 },
      { reason: 'domain_medical_records', count: 1 },
    ],
    papercuts: {
      unmet_intent: 4,
      medical_fallback: 1,
      reply_fallback: 2,
      voice_failure: 0,
      turn_failure: 1,
    },
  },
  linqChatIds: 47,
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
  w4: { retained: 0, families: 0 },
  intake: {
    started: 0,
    provisioned: 0,
    medianSeconds: null,
    derivedFamilies: 0,
    notDerivableFamilies: 0,
  },
  promises: { open: 0, overdue: 0, overdueFamilies: 0 },
  medical: { answered: 0, fallbacks: 0 },
  reverify: { ran: false, outcomes: null },
  week: {
    plansComposed: 0,
    providerIncidents: [],
    unmetIntents: [],
    papercuts: {
      unmet_intent: 0,
      medical_fallback: 0,
      reply_fallback: 0,
      voice_failure: 0,
      turn_failure: 0,
    },
  },
  linqChatIds: 0,
};

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const LONG_DIGITS = /\d{7,}/;
const NON_ASCII = /[^ -~\n]/;

describe('composeOpsDailyPost', () => {
  it('renders a day of traffic as seventeen ASCII lines of counts', () => {
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
        'W4: 3 of 8 texted back in week 4 (pooled)',
        'Intake (7d): 5 started | 4 provisioned | median first answer 1m15s (4 families)',
        'Promises: 6 open | 2 overdue (1 family)',
        'Medical (7d): 1 of 4 answers used the fixed 811/911 line',
        'Re-verify (7d): ran | checked 20 | confirmed 17 | discrepancies 1 | unverified 2',
        'Loop (7d): week plans composed 6 | provider incidents: billing 1',
        'Unmet intents (7d): capability_booking 3, domain_medical_records 1',
        'Papercuts (7d): unmet 4 | medical fallback 1 | reply fallback 2 | voice fallback 0 | turn failures 1',
        'Linq chat IDs (DB): 47 of 200',
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
        'W4: no cohort has finished week 4',
        'Intake (7d): no sessions started',
        'Promises: ledger empty',
        'Medical (7d): no medical answers',
        'Re-verify (7d): did not run',
        'Loop (7d): week plans composed 0 | provider incidents: none',
        'Unmet intents (7d): none',
        'Papercuts (7d): unmet 0 | medical fallback 0 | reply fallback 0 | voice fallback 0 | turn failures 0',
        'Linq chat IDs (DB): 0 of 200',
      ].join('\n'),
    );
  });

  it('does not read an open ledger or a sweep with no tally as a clean zero', () => {
    const text = composeOpsDailyPost({
      ...ZERO,
      intake: {
        started: 2,
        provisioned: 2,
        medianSeconds: null,
        derivedFamilies: 0,
        notDerivableFamilies: 2,
      },
      promises: { open: 4, overdue: 0, overdueFamilies: 0 },
      reverify: { ran: true, outcomes: null },
    });
    expect(text).toContain(
      'Intake (7d): 2 started | 2 provisioned | median first answer n/a (0 families) | 2 not derivable',
    );
    expect(text).toContain('Promises: 4 open | none overdue');
    expect(text).toContain('Re-verify (7d): ran | no tally');
    expect(text).not.toContain('ledger empty');
    expect(text).not.toContain('did not run');
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

  it('names the top five unmet intents and counts the rest', () => {
    const unmetIntents = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((reason) => ({
      reason: `lane_${reason}`,
      count: 1,
    }));
    const text = composeOpsDailyPost({ ...ZERO, week: { ...ZERO.week, unmetIntents } });
    expect(text).toContain(
      'Unmet intents (7d): lane_a 1, lane_b 1, lane_c 1, lane_d 1, lane_e 1 (+2 more)',
    );
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
