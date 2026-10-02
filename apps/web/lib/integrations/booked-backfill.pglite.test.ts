import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeTransport } from '~/lib/channel/intake/transport';
import type { ExtractionKind, SentinelClassification } from '~/lib/sentinel';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import {
  type EmailAlertPorts,
  type EmailAlertResult,
  type GmailAlertEnvelope,
  alertParentForGmailSweep,
  gmailAlertSweepInput,
} from './email-alert';
import type { GmailAlertBatch } from './sync';

/**
 * Historical mail, recorded once, with the parent left alone.
 *
 * The live sweep is incremental: the first run seeds a history cursor and later runs
 * only see mail added after it. A receipt that arrived before the family connected
 * Gmail is never classified. This pass reads that older booking-shaped mail and writes
 * `activity_bookings` through the same draft and dedupe key, and it must not text,
 * offer, or audit a send.
 *
 * The classifier is an injected port with a literal verdict (rule #8). Waitlist and
 * reminder refusals are the deterministic guard and must not spend a model call.
 */

let db: TestDb;
let family: { familyId: string; parentUserId: string };
let integrationId: string;

const NOW = new Date('2026-09-17T15:00:00.000Z');
const FIRST_SESSION = '2026-09-26T13:00:00.000Z';
const PHONE = '+14165551234';

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  family = await seedFamily(db.database);
  integrationId = crypto.randomUUID();
  vi.stubEnv('F14_ENABLED', 'true');
  vi.stubEnv('BOOKED_DETECTION_ENABLED', 'true');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function classified(
  over: { newTime?: string | null; title?: string; kind?: ExtractionKind } = {},
): SentinelClassification {
  return {
    status: 'classified',
    familyId: family.familyId,
    messageId: 'm1',
    extraction: {
      kind: over.kind ?? 'booking_confirmation',
      event: {
        title: over.title ?? 'Swim Level 2',
        childRef: null,
        originalTime: null,
        newTime: over.newTime === undefined ? FIRST_SESSION : over.newTime,
        location: 'the Leisure Centre',
      },
      sourceConfidence: 0.92,
      quoteEvidence: 'You are registered.',
      teenContent: false,
      teenAttributed: false,
      matchedEventRef: null,
    },
    usage: { triage: { promptTokens: 1, completionTokens: 1 }, extract: null },
  };
}

function harness(classification: SentinelClassification = classified()): {
  ports: EmailAlertPorts;
  transport: FakeTransport;
  threaded: string[];
  classifyCalls: { n: number };
} {
  const transport = new FakeTransport();
  const threaded: string[] = [];
  const classifyCalls = { n: 0 };
  return {
    ports: {
      classify: async () => {
        classifyCalls.n += 1;
        return classification;
      },
      gate: async () => ({ allowed: true, optOut: 'full' as const }),
      resolvePhone: async () => PHONE,
      transport,
      threadMessage: async (_database, input) => {
        threaded.push(input.body);
        return 'conv-1';
      },
      timeZone: async () => 'America/Toronto',
    },
    transport,
    threaded,
    classifyCalls,
  };
}

function envelope(
  over: Partial<GmailAlertEnvelope> & Pick<GmailAlertEnvelope, 'messageId'>,
): GmailAlertEnvelope {
  return {
    subject: 'Registration Confirmation - Swim Level 2',
    from: 'Brookfield Recreation <noreply@recreation.brookfield.example.ca>',
    snippet: "You're registered for Swim Level 2.",
    receivedAt: '2026-09-17T14:00:00.000Z',
    ...over,
  };
}

function backfill(
  h: ReturnType<typeof harness>,
  envelopes: GmailAlertEnvelope[],
): Promise<readonly EmailAlertResult[]> {
  return alertParentForGmailSweep(
    db.database,
    {
      familyId: family.familyId,
      parentUserId: family.parentUserId,
      integrationId,
      seeding: false,
      backfill: true,
      envelopes,
      now: NOW,
    },
    h.ports,
  );
}

function bookingRows() {
  return db.database
    .select()
    .from(schema.activityBookings)
    .where(eq(schema.activityBookings.familyId, family.familyId));
}

describe('booked-detection backfill', () => {
  it('writes one booking and a second run refreshes nothing into a second row', async () => {
    const h = harness();
    const logged = vi.spyOn(console, 'info').mockImplementation(() => {});
    const mail = envelope({ messageId: 'receipt-1' });

    const first = await backfill(h, [mail]);
    const second = await backfill(h, [mail]);

    expect(first).toEqual([{ alert: 'backfill_suppressed', booking: 'recorded', going: null }]);
    expect(second).toEqual([
      { alert: 'backfill_suppressed', booking: 'already_recorded', going: null },
    ]);
    const rows = await bookingRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.dedupeKey).toBe('recreation.brookfield.example.ca|swim level 2|2026-09-26');
    expect(rows[0]?.channelMessageId).toBeNull();
    expect(logged).toHaveBeenCalledWith(
      expect.objectContaining({
        pass: 'backfill',
        alert: 'backfill_suppressed',
        booking: 'recorded',
        skip: null,
        familyId: family.familyId,
        integrationId,
      }),
      'gmail sweep: envelope outcome',
    );
  });

  it('suppresses the parent alert: no text, no offer, no email_alert_sent', async () => {
    const h = harness();
    await backfill(h, [envelope({ messageId: 'receipt-quiet' })]);

    expect(h.transport.sent).toEqual([]);
    expect(h.threaded).toEqual([]);
    const offers = await db.database
      .select()
      .from(schema.emailAlertOffers)
      .where(eq(schema.emailAlertOffers.familyId, family.familyId));
    expect(offers).toEqual([]);
    const messages = await db.database
      .select()
      .from(schema.channelMessages)
      .where(eq(schema.channelMessages.familyId, family.familyId));
    expect(messages).toEqual([]);
    const audits = await db.database
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.familyId, family.familyId));
    expect(audits.map((row) => row.actionTaken)).not.toContain('email_alert_sent');
    expect(audits.map((row) => row.actionTaken)).toContain('activity_booking_recorded');
    const recorded = audits.find((row) => row.actionTaken === 'activity_booking_recorded');
    expect(recorded?.after).toEqual({ offered: false });
  });

  it('refuses waitlist mail and a registration reminder without a model call', async () => {
    const h = harness();
    const outcomes = await backfill(h, [
      envelope({
        messageId: 'wait',
        subject: 'Thank you for joining our BrightPath Georgetown waitlist!',
        from: 'BrightPath <hello@waitlistplus.com>',
        snippet: 'You are on the waitlist for the Georgetown location.',
        receivedAt: '2026-09-30T14:00:00.000Z',
      }),
      envelope({
        messageId: 'opens',
        subject: 'REMINDER!!! Term 2 registration opens TOMORROW at 8:00am',
        from: 'Cartwheels Gym <hello@uplifterinc.com>',
        snippet: 'Term 2 registration opens tomorrow at 8:00am.',
        receivedAt: '2026-09-30T13:00:00.000Z',
      }),
    ]);

    expect(outcomes.map((outcome) => outcome.booking)).toEqual(['waitlist', 'reminder_only']);
    expect(outcomes.map((outcome) => outcome.alert)).toEqual([
      'backfill_suppressed',
      'backfill_suppressed',
    ]);
    expect(h.classifyCalls.n).toBe(0);
    expect(h.transport.sent).toEqual([]);
    expect(await bookingRows()).toEqual([]);
  });

  it('refuses an expired-session confirmation as no_first_session', async () => {
    const h = harness(classified({ newTime: '2026-08-29T15:00:00.000Z', title: 'Parent and Tot' }));
    const [outcome] = await backfill(h, [
      envelope({
        messageId: 'expired',
        subject: 'Booking Confirmation for Parent and Tot',
        from: 'Xplore <noreply@xplorrecreation.com>',
        snippet: 'Your booking is confirmed.',
      }),
    ]);

    expect(outcome).toEqual({
      alert: 'backfill_suppressed',
      booking: 'no_first_session',
      going: null,
    });
    expect(h.classifyCalls.n).toBe(1);
    expect(await bookingRows()).toEqual([]);
    expect(h.transport.sent).toEqual([]);
  });

  it('logs a non-seeding live sweep that skipped everything, and stays quiet on a seed', async () => {
    const logged = vi.spyOn(console, 'info').mockImplementation(() => {});
    const h = harness();
    h.ports.classify = async () => ({
      status: 'triaged_out',
      familyId: family.familyId,
      messageId: 'news',
      extraction: null,
      usage: { triage: { promptTokens: 1, completionTokens: 1 }, extract: null },
    });
    const live = await alertParentForGmailSweep(
      db.database,
      {
        familyId: family.familyId,
        parentUserId: family.parentUserId,
        integrationId,
        seeding: false,
        envelopes: [envelope({ messageId: 'news', subject: 'Weekly newsletter' })],
        now: NOW,
      },
      h.ports,
    );
    expect(live).toEqual([{ alert: 'not_parenting', booking: null, going: null }]);
    expect(logged).toHaveBeenCalledWith(
      expect.objectContaining({
        pass: 'incremental',
        alert: 'not_parenting',
        booking: null,
        skip: 'not_parenting',
      }),
      'gmail sweep: envelope outcome',
    );

    logged.mockClear();
    await alertParentForGmailSweep(
      db.database,
      {
        familyId: family.familyId,
        parentUserId: family.parentUserId,
        integrationId,
        seeding: true,
        envelopes: [envelope({ messageId: 'old' })],
        now: NOW,
      },
      h.ports,
    );
    expect(logged).not.toHaveBeenCalled();
  });
});

describe('gmailAlertSweepInput', () => {
  it('marks a backfill batch so the live sweep cannot text it', () => {
    const batch: GmailAlertBatch = {
      connection: {
        id: integrationId,
        familyId: family.familyId,
        userId: family.parentUserId,
        provider: 'gmail',
        providerMetadata: {},
        tokens: { accessToken: 'ya29' },
      },
      accessToken: 'ya29',
      seeding: true,
      pass: 'backfill',
      envelopes: [],
    };
    expect(gmailAlertSweepInput(batch, NOW)).toMatchObject({
      backfill: true,
      seeding: false,
      integrationId,
    });
  });
});
