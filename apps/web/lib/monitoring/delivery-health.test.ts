import { schema } from '@hale/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gsm7SingleSegment } from '~/lib/channel/twilio/triage';
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
 * land in the ledger (the sweep's job), a failure rate above threshold — or a single
 * registration-class refusal, which means EVERY send to that class of destination is
 * dying — is a pageable incident, not a row someone might notice in an admin table.
 * Prod motivation: 42/177 sends failed over 30d (8 of them 30034) and nothing paged.
 */

const NOW = new Date('2026-09-03T12:00:00.000Z');

function stats(over: Partial<DeliveryStats> = {}): DeliveryStats {
  return { attempted: 20, failed: 0, codes: [], ...over };
}

describe('evaluateDeliveryHealth', () => {
  it('reports a registration incident on ANY 30034-class failure — one is already too many', () => {
    const incident = evaluateDeliveryHealth(
      stats({ failed: 1, codes: [{ code: '30034', count: 1 }] }),
    );

    expect(incident).toEqual({ kind: 'registration_error', code: '30034', count: 1 });
  });

  it('registration outranks the rate: a mixed failure wave names the registration problem first', () => {
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

    expect(incident).toMatchObject({ kind: 'registration_error', count: 2 });
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
    expect(evaluateDeliveryHealth(stats({ attempted: 8, failed: 1, codes: [{ code: '30006', count: 1 }] }))).toBeNull();
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
  it('the registration page is one GSM-7 segment and carries the class, never a number a parent owns', () => {
    const body = composeDeliveryAlert({ kind: 'registration_error', code: '30034', count: 8 });

    expect(gsm7SingleSegment(body)).toBe(true);
    expect(body).toContain('30034');
    expect(body).toContain('8');
    // Rule #1, structurally: nothing that could be a phone number.
    expect(body).not.toMatch(/\d{7,}/);
  });

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
    channel?: 'sms' | 'whatsapp' | 'email';
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
    await seed({ status: 'failed', errorCode: '30034' });
    // Diluters (the msgsOut lesson): none of these may enter the rate.
    await seed({ status: 'suppressed_cap' });
    await seed({ status: 'delivered', direction: 'in' });
    await seed({ status: 'sent', channel: 'email' });
    // Outside the window.
    await seed({ status: 'failed', errorCode: '30006', createdAt: new Date(NOW.getTime() - 48 * 3_600_000) });

    const result = await loadDeliveryStats(db.database, new Date(NOW.getTime() - 24 * 3_600_000));

    expect(result.attempted).toBe(6);
    expect(result.failed).toBe(3);
    expect(result.codes).toEqual([
      { code: '30006', count: 2 },
      { code: '30034', count: 1 },
    ]);
  });

  it('one page per incident kind per window: the claim is atomic and the second claimer loses', async () => {
    expect(await claimDeliveryIncident(db.database, 'registration_error', NOW)).toBe(true);
    expect(await claimDeliveryIncident(db.database, 'registration_error', NOW)).toBe(false);
    // A different kind is a different incident.
    expect(await claimDeliveryIncident(db.database, 'failure_rate', NOW)).toBe(true);
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
      sendSms: vi.fn().mockImplementation(async (body: string) => {
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

  it('the 15-minute founder-SMS floor holds across incident kinds (the alert.ts convention)', async () => {
    const first = fakes({
      stats: stats({ attempted: 10, failed: 5, codes: [{ code: '30006', count: 5 }] }),
    });
    await checkDeliveryHealth(database, first.deps, NOW);

    const second = fakes({
      stats: stats({ failed: 1, codes: [{ code: '30034', count: 1 }] }),
    });
    const outcome = await checkDeliveryHealth(
      database,
      second.deps,
      new Date(NOW.getTime() + 60_000),
    );

    expect(outcome).toEqual({ outcome: 'suppressed_instance_window', kind: 'registration_error' });
    expect(second.sent).toEqual([]);

    // And it is a WINDOW, not a latch: past 15 minutes the page goes out.
    const third = fakes({
      stats: stats({ failed: 1, codes: [{ code: '30034', count: 1 }] }),
    });
    const later = await checkDeliveryHealth(
      database,
      third.deps,
      new Date(NOW.getTime() + 16 * 60_000),
    );
    expect(later).toEqual({ outcome: 'alerted', kind: 'registration_error' });
  });

  it('a refused or unconfigured SMS leg is a named outcome, never a silent success', async () => {
    const failed = fakes({
      stats: stats({ failed: 1, codes: [{ code: '30034', count: 1 }] }),
      sms: 'failed',
    });
    expect(await checkDeliveryHealth(database, failed.deps, NOW)).toEqual({
      outcome: 'alert_send_failed',
      kind: 'registration_error',
    });

    resetDeliveryAlertWindowForTests();
    const dark = fakes({
      stats: stats({ failed: 1, codes: [{ code: '30034', count: 1 }] }),
      sms: 'skipped_not_configured',
    });
    expect(await checkDeliveryHealth(database, dark.deps, NOW)).toEqual({
      outcome: 'skipped_not_configured',
      kind: 'registration_error',
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
