import { schema } from '@hale/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SEND_RETRIES_EXHAUSTED } from '~/lib/channel/config';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import {
  DELIVERY_RATE_MIN_ATTEMPTED,
  DELIVERY_RATE_THRESHOLD,
  type DeliveryStats,
  checkDeliveryHealth,
  claimDeliveryIncident,
  composeDeliveryAlert,
  evaluateDeliveryHealth,
  loadDeliveryStats,
  resetDeliveryAlertWindowForTests,
} from './delivery-health';

/**
 * The alerting half of the delivery-truth invariant: once failed statuses actually
 * land in the ledger (the sweep's job), a failure rate above threshold is a pageable
 * incident, not a row someone might notice in an admin table.
 * Prod motivation: 42/177 sends failed over 30d and nothing paged.
 */

const NOW = new Date('2026-09-03T12:00:00.000Z');

/** GSM-7 basic set, one 160-septet segment. Ops alert copy stays inside it. */
const GSM7_BASIC_SAFE = /^[A-Za-z0-9 @$_!"#%&'()*+,\-./:;<=>?\n]*$/;

function gsm7SingleSegment(body: string): boolean {
  return GSM7_BASIC_SAFE.test(body) && body.length <= 160;
}

function stats(over: Partial<DeliveryStats> = {}): DeliveryStats {
  return { attempted: 20, failed: 0, codes: [], ...over };
}

describe('evaluateDeliveryHealth', () => {
  it('does not give a lone 30034 its own incident — below the rate bar it is quiet', () => {
    expect(
      evaluateDeliveryHealth(stats({ failed: 1, codes: [{ code: '30034', count: 1 }] })),
    ).toBeNull();
  });

  it('a mixed failure wave that includes 30034 is still the rate incident', () => {
    const incident = evaluateDeliveryHealth(
      stats({
        attempted: 10,
        failed: 9,
        codes: [
          { code: '30006', count: 7 },
          { code: '30034', count: 2 },
        ],
      }),
    );

    expect(incident).toEqual({
      kind: 'failure_rate',
      failed: 9,
      attempted: 10,
      codes: [
        { code: '30006', count: 7 },
        { code: '30034', count: 2 },
      ],
    });
  });

  it('reports a failure-rate incident at the threshold, carrying the code breakdown', () => {
    const incident = evaluateDeliveryHealth(
      stats({
        attempted: 8,
        failed: 2,
        codes: [{ code: '30006', count: 2 }],
      }),
    );

    expect(DELIVERY_RATE_THRESHOLD).toBe(0.25);
    expect(incident).toEqual({
      kind: 'failure_rate',
      failed: 2,
      attempted: 8,
      codes: [{ code: '30006', count: 2 }],
    });
  });

  it('stays quiet below the threshold, and on too small a sample to mean anything', () => {
    expect(
      evaluateDeliveryHealth(
        stats({ attempted: 8, failed: 1, codes: [{ code: '30006', count: 1 }] }),
      ),
    ).toBeNull();
    expect(
      evaluateDeliveryHealth(
        stats({
          attempted: DELIVERY_RATE_MIN_ATTEMPTED - 1,
          failed: DELIVERY_RATE_MIN_ATTEMPTED - 1,
          codes: [{ code: '30006', count: DELIVERY_RATE_MIN_ATTEMPTED - 1 }],
        }),
      ),
    ).toBeNull();
  });

  it('a clean window is healthy', () => {
    expect(evaluateDeliveryHealth(stats())).toBeNull();
  });
});

describe('composeDeliveryAlert', () => {
  it('the rate page is one GSM-7 segment and carries counts plus the top error codes only', () => {
    const body = composeDeliveryAlert({
      kind: 'failure_rate',
      failed: 12,
      attempted: 30,
      codes: [
        { code: '30006', count: 9 },
        { code: '21614', count: 2 },
        { code: '30007', count: 1 },
      ],
    });

    expect(gsm7SingleSegment(body)).toBe(true);
    expect(body).toContain('12');
    expect(body).toContain('30');
    expect(body).toContain('30006');
    expect(body).not.toMatch(/\d{7,}/);
  });

  it('a provider code is clamped to a short enum-shaped token before it reaches the page', () => {
    // Linq relays `data.code` as whatever string the provider sent. The page must never
    // carry free text or a digit run that could be a number a parent owns.
    const body = composeDeliveryAlert({
      kind: 'failure_rate',
      failed: 10,
      attempted: 10,
      codes: [{ code: 'recipient 4165551234 blocked: see https://x.test/a?b=c', count: 10 }],
    });

    expect(body).not.toMatch(/\d{7,}/);
    expect(body).not.toContain('https://');
    expect(body).not.toContain(' blocked');
    expect(body).toMatch(/Codes: [A-Za-z0-9_.:-]{1,32} x10\./);
    expect(gsm7SingleSegment(body)).toBe(true);
  });

  it('the rate page points ops at Linq and the receipts ledger', () => {
    const body = composeDeliveryAlert({
      kind: 'failure_rate',
      failed: 10,
      attempted: 10,
      codes: [{ code: 'send_retries_exhausted', count: 10 }],
    });

    expect(body).not.toMatch(/twilio/i);
    expect(body).toContain('Linq');
    expect(body).toContain('channel_messages');
    expect(gsm7SingleSegment(body)).toBe(true);
  });
});

describe('loadDeliveryStats (real DDL)', () => {
  let db: TestDb;
  let family: { familyId: string; parentUserId: string };

  // Booted in a hook, not the test body: pglite boot + migrations routinely
  // exceed the 5s test timeout under parallel CI load.
  beforeEach(async () => {
    db = await createTestDb();
    family = await seedFamily(db.database);
  });

  afterEach(async () => {
    await db.close();
  });

  async function seed(over: {
    status: 'queued' | 'sent' | 'delivered' | 'failed' | 'suppressed_cap';
    channel?: 'sms' | 'imessage' | 'whatsapp' | 'email';
    direction?: 'in' | 'out';
    errorCode?: string | null;
    createdAt?: Date;
  }) {
    await db.database.insert(schema.channelMessages).values({
      familyId: family.familyId,
      parentUserId: family.parentUserId,
      channel: over.channel ?? 'sms',
      direction: over.direction ?? 'out',
      category: 'reply',
      status: over.status,
      errorCode: over.errorCode ?? null,
      createdAt: over.createdAt ?? new Date(NOW.getTime() - 3_600_000),
    });
  }

  it('counts attempted sends only — a suppression is not a send, inbound is not ours, email has no receipt loop', async () => {
    await seed({ status: 'delivered' });
    await seed({ status: 'sent' });
    await seed({ status: 'queued' });
    await seed({ status: 'failed', errorCode: '30006' });
    await seed({ status: 'failed', errorCode: '30006', channel: 'whatsapp' });
    // A historical whatsapp row is not in the SMS receipt rate.
    await seed({ status: 'failed', errorCode: '30034' });
    // Diluters (the msgsOut lesson): none of these may enter the rate.
    await seed({ status: 'suppressed_cap' });
    await seed({ status: 'delivered', direction: 'in' });
    await seed({ status: 'sent', channel: 'email' });
    // Outside the window.
    await seed({
      status: 'failed',
      errorCode: '30006',
      createdAt: new Date(NOW.getTime() - 48 * 3_600_000),
    });

    const result = await loadDeliveryStats(db.database, new Date(NOW.getTime() - 24 * 3_600_000));

    expect(result.attempted).toBe(5);
    expect(result.failed).toBe(2);
    expect(result.codes).toEqual([
      { code: '30006', count: 1 },
      { code: '30034', count: 1 },
    ]);
  });

  it('counts Linq sends: failed imessage rows in the window are attempted, failed, and trip the rate incident', async () => {
    for (let i = 0; i < 10; i++) {
      await seed({ status: 'failed', channel: 'imessage', errorCode: SEND_RETRIES_EXHAUSTED });
    }

    const result = await loadDeliveryStats(db.database, new Date(NOW.getTime() - 24 * 3_600_000));

    expect(result.attempted).toBe(10);
    expect(result.failed).toBe(10);
    expect(evaluateDeliveryHealth(result)).toEqual({
      kind: 'failure_rate',
      failed: 10,
      attempted: 10,
      codes: [{ code: SEND_RETRIES_EXHAUSTED, count: 10 }],
    });
  });

  it('one page per incident kind per window: the claim is atomic and the second claimer loses', async () => {
    expect(await claimDeliveryIncident(db.database, 'failure_rate', NOW)).toBe(true);
    expect(await claimDeliveryIncident(db.database, 'failure_rate', NOW)).toBe(false);
  });
});

describe('checkDeliveryHealth', () => {
  beforeEach(() => {
    resetDeliveryAlertWindowForTests();
  });

  function fakes(over: {
    stats: DeliveryStats;
    claim?: boolean;
    sms?: 'sent' | 'failed' | 'skipped_not_configured';
  }) {
    const sent: string[] = [];
    const deps = {
      loadStats: vi.fn().mockResolvedValue(over.stats),
      claim: vi.fn().mockResolvedValue(over.claim ?? true),
      sendAlert: vi.fn().mockImplementation(async (body: string) => {
        sent.push(body);
        return over.sms ?? 'sent';
      }),
    };
    return { deps, sent };
  }

  const database = {} as never;

  it('a healthy window sends nothing and says so', async () => {
    const { deps, sent } = fakes({ stats: stats() });

    const outcome = await checkDeliveryHealth(database, deps, NOW);

    expect(outcome).toEqual({ outcome: 'healthy', attempted: 20, failed: 0 });
    expect(sent).toEqual([]);
  });

  it('pages the founder when the rate crosses the threshold — the positive control for the quiet path above', async () => {
    const { deps, sent } = fakes({
      stats: stats({ attempted: 10, failed: 5, codes: [{ code: '30006', count: 5 }] }),
    });

    const outcome = await checkDeliveryHealth(database, deps, NOW);

    expect(outcome).toEqual({ outcome: 'alerted', kind: 'failure_rate' });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('30006');
    expect(deps.claim).toHaveBeenCalledWith(database, 'failure_rate', NOW);
  });

  it('an already-claimed incident window suppresses the page, named', async () => {
    const { deps, sent } = fakes({
      stats: stats({ attempted: 10, failed: 5, codes: [{ code: '30006', count: 5 }] }),
      claim: false,
    });

    const outcome = await checkDeliveryHealth(database, deps, NOW);

    expect(outcome).toEqual({ outcome: 'suppressed_dedupe', kind: 'failure_rate' });
    expect(sent).toEqual([]);
  });

  it('the 15-minute page floor holds for a later rate incident (the alert.ts convention)', async () => {
    const rate = () =>
      stats({
        attempted: 10,
        failed: 5,
        codes: [{ code: SEND_RETRIES_EXHAUSTED, count: 5 }],
      });
    const first = fakes({
      stats: stats({ attempted: 10, failed: 5, codes: [{ code: '30006', count: 5 }] }),
    });
    await checkDeliveryHealth(database, first.deps, NOW);

    const second = fakes({ stats: rate() });
    const outcome = await checkDeliveryHealth(
      database,
      second.deps,
      new Date(NOW.getTime() + 60_000),
    );

    expect(outcome).toEqual({ outcome: 'suppressed_instance_window', kind: 'failure_rate' });
    expect(second.sent).toEqual([]);

    // And it is a WINDOW, not a latch: past 15 minutes the page goes out.
    const third = fakes({ stats: rate() });
    const later = await checkDeliveryHealth(
      database,
      third.deps,
      new Date(NOW.getTime() + 16 * 60_000),
    );
    expect(later).toEqual({ outcome: 'alerted', kind: 'failure_rate' });
  });

  it('a refused or unconfigured Slack leg is a named outcome, never a silent success', async () => {
    const rate = stats({
      attempted: 10,
      failed: 5,
      codes: [{ code: SEND_RETRIES_EXHAUSTED, count: 5 }],
    });
    const failed = fakes({
      stats: rate,
      sms: 'failed',
    });
    expect(await checkDeliveryHealth(database, failed.deps, NOW)).toEqual({
      outcome: 'alert_send_failed',
      kind: 'failure_rate',
    });

    resetDeliveryAlertWindowForTests();
    const dark = fakes({
      stats: rate,
      sms: 'skipped_not_configured',
    });
    expect(await checkDeliveryHealth(database, dark.deps, NOW)).toEqual({
      outcome: 'skipped_not_configured',
      kind: 'failure_rate',
    });
  });

  it('a claim store that cannot answer is named, and the page is withheld rather than doubled', async () => {
    const { deps, sent } = fakes({
      stats: stats({ attempted: 10, failed: 5, codes: [{ code: '30006', count: 5 }] }),
    });
    deps.claim.mockRejectedValue(new Error('db down'));

    const outcome = await checkDeliveryHealth(database, deps, NOW);

    expect(outcome).toEqual({ outcome: 'claim_unavailable', kind: 'failure_rate' });
    expect(sent).toEqual([]);
  });
});
