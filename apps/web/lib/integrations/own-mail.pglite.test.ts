import { randomUUID } from 'node:crypto';
import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeTransport } from '~/lib/channel/intake/transport';
import type {
  CorrelatedEventRef,
  ExtractedEvent,
  ExtractionKind,
  InboxEnvelope,
  SentinelClassification,
} from '~/lib/sentinel';
import { type ScriptedNoticeWriter, scriptedNoticeWriter } from '~/lib/testing/email-alert-notice';
import { type TestDb, createTestDb, seedFamily, seedIntegration } from '~/lib/testing/pglite';
import {
  EMAIL_ALERT_TEMPLATE_KEY,
  type EmailAlertPorts,
  type EmailAlertResult,
  type GmailAlertEnvelope,
  alertParentForGmailSweep,
  emailAlertOccasion,
  emailAlertOccasionKey,
  gmailAlertSweepInput,
} from './email-alert';
import { untrackItem } from './kid-relevance/untrack';
import { type GoogleFetch, type SyncDeps, backfillBookedMail, syncConnection } from './sync';

/**
 * The parent's OWN mail is not news to the parent, and one occasion in one
 * conversation is told once.
 *
 * The REAL sync (a route-table googleFetch) feeds the REAL alert sweep over the REAL DDL.
 * The classifier and the notice writer are ports with literal answers (rule #8): what is
 * under test is which envelopes ever reach them, and what the ledger key makes of the
 * ones that do.
 */

let db: TestDb;
let family: { familyId: string; parentUserId: string };
let integrationId: string;

const NOW = new Date('2026-11-03T18:00:00.000Z');
const FAMILY_TIMEZONE = 'America/Denver';
const CHILD_ID = '00000000-0000-4000-8000-0000000000c7';
const PHONE = '+13035550123';
const SATURDAY = '2026-11-14T16:00:00.000Z';

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  family = await seedFamily(db.database);
  integrationId = randomUUID();
  vi.stubEnv('F14_ENABLED', 'true');
  vi.stubEnv('EMAIL_ALERT_ENABLED', 'true');
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function extraction(
  over: Partial<ExtractedEvent> & {
    kind?: ExtractionKind;
    matchedEventRef?: CorrelatedEventRef | null;
  } = {},
): NonNullable<SentinelClassification['extraction']> {
  const { kind = 'new_event', matchedEventRef = null, ...event } = over;
  return {
    kind,
    event: {
      title: 'Saturday swim',
      childRef: CHILD_ID,
      originalTime: null,
      newTime: SATURDAY,
      location: null,
      ...event,
    },
    sourceConfidence: 0.92,
    quoteEvidence: 'Swim starts Saturday at nine.',
    teenContent: false,
    teenAttributed: false,
    matchedEventRef,
  };
}

function classified(
  over: Parameters<typeof extraction>[0] = {},
  messageId = 'k1',
): SentinelClassification {
  return {
    status: 'classified',
    familyId: family.familyId,
    messageId,
    extraction: extraction(over),
    usage: { triage: { promptTokens: 1, completionTokens: 1 }, extract: null },
  };
}

interface Harness {
  ports: EmailAlertPorts;
  transport: FakeTransport;
  writer: ScriptedNoticeWriter;
  classified: string[];
}

/** `byMessage` answers per message id; anything else is a plain new_event. */
function harness(byMessage: Record<string, SentinelClassification> = {}): Harness {
  const transport = new FakeTransport();
  const writer = scriptedNoticeWriter({
    children: [{ id: CHILD_ID, name: 'Wren', ageInMonths: 50 }],
  });
  const h: Harness = {
    transport,
    writer,
    classified: [],
    ports: {
      familyChildren: writer.familyChildren,
      writeNotice: writer.writeNotice,
      parentLanguage: writer.parentLanguage,
      classify: async (envelope: InboxEnvelope) => {
        h.classified.push(envelope.messageId);
        return byMessage[envelope.messageId] ?? classified({}, envelope.messageId);
      },
      gate: async () => ({ allowed: true, optOut: 'full' }),
      resolvePhone: async () => PHONE,
      transport,
      threadMessage: async () => 'conv-1',
      timeZone: async () => FAMILY_TIMEZONE,
    },
  };
  return h;
}

function alertRows() {
  return db.database
    .select()
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.familyId, family.familyId),
        eq(schema.channelMessages.category, 'email_alert'),
      ),
    );
}

function bookingRows() {
  return db.database
    .select()
    .from(schema.activityBookings)
    .where(eq(schema.activityBookings.familyId, family.familyId));
}

// ── The real sync, over a route-table Gmail ─────────────────────────────────────

interface FakeMessage {
  id: string;
  threadId?: string;
  labelIds?: string[];
  internalDate: string;
}

function metadata(message: FakeMessage) {
  return {
    id: message.id,
    ...(message.threadId === undefined ? {} : { threadId: message.threadId }),
    ...(message.labelIds === undefined ? {} : { labelIds: message.labelIds }),
    snippet: 'Swim starts Saturday at nine.',
    internalDate: message.internalDate,
    payload: {
      headers: [
        { name: 'Subject', value: 'Swim this Saturday' },
        { name: 'From', value: 'Aspen Aquatics <hello@aspen-aquatics.example>' },
      ],
    },
  };
}

function gmail(messages: readonly FakeMessage[]): GoogleFetch {
  return async (url) => {
    const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
    if (url.includes('/history?')) {
      return ok({
        history: [{ id: '150', messagesAdded: messages.map((m) => ({ message: { id: m.id } })) }],
        historyId: '200',
      });
    }
    const id = /\/messages\/([^?]+)\?/.exec(url)?.[1];
    const message = messages.find((m) => m.id === id);
    if (message) return ok(metadata(message));
    throw new Error(`no route for ${url}`);
  };
}

function gmailConnection() {
  return {
    id: integrationId,
    familyId: family.familyId,
    userId: family.parentUserId,
    provider: 'gmail' as const,
    providerMetadata: { historyId: '100' },
    tokens: { accessToken: 'ya29.test', refreshToken: '1//r', expiresAt: Date.now() + 3600_000 },
  };
}

function sweepPort(h: Harness): SyncDeps['alertGmailEnvelopes'] {
  return (batch) =>
    alertParentForGmailSweep(db.database, gmailAlertSweepInput(batch, NOW), h.ports);
}

async function sync(h: Harness, messages: readonly FakeMessage[]) {
  const deps: SyncDeps = {
    googleFetch: gmail(messages),
    enqueue: async () => {},
    childNames: ['Wren'],
    saveCursor: async () => {},
    markError: async () => {
      throw new Error('the connection was marked errored');
    },
    refreshTokens: async () => ({ accessToken: 'ya29.refreshed' }),
    saveTokens: async () => {},
    alertGmailEnvelopes: sweepPort(h),
    alertCalendarChanges: async () => ({ changes: [], reoffers: [] }),
    detectTravelBookings: async (batch) => batch.envelopes.map(() => 'dark' as const),
    mirrorCalendarWindow: async () => ({
      mirrored: 0,
      updated: 0,
      removed: 0,
      alreadyKnown: 0,
      skipped: 0,
      held: false,
    }),
  };
  return syncConnection(gmailConnection(), deps);
}

const at = (minute: number) => String(Date.parse('2026-11-03T15:00:00.000Z') + minute * 60_000);

function sweep(h: Harness, envelopes: readonly GmailAlertEnvelope[]) {
  return alertParentForGmailSweep(
    db.database,
    {
      familyId: family.familyId,
      parentUserId: family.parentUserId,
      integrationId,
      seeding: false,
      envelopes,
      now: NOW,
    },
    h.ports,
  );
}

function inbound(messageId: string, threadId: string, minute: number): GmailAlertEnvelope {
  return {
    messageId,
    threadId,
    labelIds: ['INBOX'],
    subject: 'Swim this Saturday',
    from: 'Aspen Aquatics <hello@aspen-aquatics.example>',
    snippet: 'Swim starts Saturday at nine.',
    receivedAt: new Date(Number(at(minute))).toISOString(),
  };
}

const alerts = (results: readonly EmailAlertResult[]) => results.map((r) => r.alert);

describe('the parent’s own mail never reaches the classifier', () => {
  it('T1: a SENT message and a DRAFT make no classifier call; inbound kid mail is still told', async () => {
    const h = harness();
    const result = await sync(h, [
      { id: 's1', threadId: 't-s1', labelIds: ['SENT'], internalDate: at(1) },
      { id: 'd1', threadId: 't-d1', labelIds: ['DRAFT'], internalDate: at(2) },
      { id: 'k1', threadId: 't-k1', labelIds: ['INBOX', 'CATEGORY_UPDATES'], internalDate: at(3) },
    ]);

    // Newest first: each refusal sits where its envelope does.
    expect(alerts(result.emailAlerts)).toEqual(['sent', 'draft', 'own_mail']);
    expect(h.classified).toEqual(['k1']);
    expect(h.writer.seen).toHaveLength(1);
    expect(h.transport.sent).toHaveLength(1);
    await expect(alertRows()).resolves.toHaveLength(1);
  });

  it('T2: an envelope built with no label read is refused; a 200 with no labelIds is read as no labels', async () => {
    const direct = harness();
    const { labelIds: _unread, ...unlabelled } = inbound('u1', 't-u1', 1);
    await expect(
      sweep(direct, [unlabelled, inbound('k1', 't-k1', 2)]).then(alerts),
    ).resolves.toEqual(['sent', 'labels_unread']);
    expect(direct.classified).toEqual(['k1']);

    // Gmail omits an empty repeated field: archived, read mail with no label at all.
    const viaSync = harness();
    const result = await sync(viaSync, [{ id: 'a1', threadId: 't-a1', internalDate: at(3) }]);
    expect(alerts(result.emailAlerts)).toEqual(['sent']);
    expect(viaSync.classified).toEqual(['a1']);
  });

  it('T3: three autosaves of one draft (three message ids) are zero alerts', async () => {
    const h = harness();
    const result = await sync(h, [
      { id: 'd1', threadId: 't-draft', labelIds: ['DRAFT'], internalDate: at(1) },
      { id: 'd2', threadId: 't-draft', labelIds: ['DRAFT'], internalDate: at(2) },
      { id: 'd3', threadId: 't-draft', labelIds: ['DRAFT'], internalDate: at(3) },
      { id: 'k1', threadId: 't-k1', labelIds: ['INBOX'], internalDate: at(4) },
    ]);

    expect(alerts(result.emailAlerts)).toEqual(['sent', 'draft', 'draft', 'draft']);
    // The positive control is k1: the only classifier call, the only writer call, the only row.
    expect(h.classified).toEqual(['k1']);
    expect(h.writer.seen).toHaveLength(1);
    expect(h.transport.sent).toHaveLength(1);
    await expect(alertRows()).resolves.toHaveLength(1);
  });

  it('T8: the backfill pass refuses the parent’s own receipt before the classifier', async () => {
    vi.stubEnv('BOOKED_DETECTION_ENABLED', 'true');
    vi.stubEnv('BOOKED_DETECTION_BACKFILL_ENABLED', 'true');
    const receipt = classified({ kind: 'booking_confirmation', title: 'Swim Level 2' }, 'r1');

    async function backfill(labelIds: string[]) {
      const h = harness({ r1: receipt });
      const message = { id: 'r1', threadId: 't-r1', labelIds, internalDate: at(1) };
      const connection = gmailConnection();
      const run = await backfillBookedMail(
        connection,
        'ya29.test',
        {
          googleFetch: async (url) => {
            if (url.includes('/messages?')) {
              return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'r1' }] }) };
            }
            return { ok: true, status: 200, json: async () => metadata(message) };
          },
          alertGmailEnvelopes: sweepPort(h),
          saveCursor: async () => {},
        },
        connection.providerMetadata,
      );
      return { h, run };
    }

    const own = await backfill(['SENT']);
    expect(own.run).toMatchObject({
      status: 'saved',
      alerts: [{ alert: 'own_mail', booking: null, going: null }],
    });
    expect(own.h.classified).toEqual([]);
    await expect(bookingRows()).resolves.toEqual([]);

    // The control: the same receipt, arrived in the inbox, is read and recorded quietly.
    const theirs = await backfill(['INBOX']);
    expect(theirs.run).toMatchObject({
      status: 'saved',
      alerts: [{ alert: 'backfill_suppressed', booking: 'recorded', going: null }],
    });
    expect(theirs.h.classified).toEqual(['r1']);
    await expect(bookingRows()).resolves.toHaveLength(1);
  });

  it('T9: a live envelope with no thread id is not alerted', async () => {
    const h = harness();
    const { threadId: _none, ...threadless } = inbound('k1', 't-k1', 1);
    await expect(sweep(h, [threadless]).then(alerts)).resolves.toEqual(['no_thread_id']);
    expect(h.classified).toEqual([]);

    await expect(sweep(h, [inbound('k1', 't-k1', 1)]).then(alerts)).resolves.toEqual(['sent']);
    expect(h.classified).toEqual(['k1']);
  });
});

describe('one occasion in one thread is told once', () => {
  it('T4: two messages in one thread about the same Saturday are one alert', async () => {
    const h = harness();
    const outcomes = await sweep(h, [inbound('k1', 't-swim', 0), inbound('k2', 't-swim', 10)]);

    // Newest first: k2 is told, k1 is the same news.
    expect(alerts(outcomes)).toEqual(['sent', 'already_sent']);
    expect(h.classified).toEqual(['k2', 'k1']);
    expect(h.writer.seen).toHaveLength(1);
    expect(h.transport.sent).toHaveLength(1);
    const rows = await alertRows();
    expect(rows.map((r) => r.dedupeKey)).toEqual([`email_alert:${integrationId}:k2`]);
    // The occasion claim points at the one alert row.
    await expect(
      db.database
        .select({ channelMessageId: schema.emailAlertOccasions.channelMessageId })
        .from(schema.emailAlertOccasions)
        .innerJoin(
          schema.channelMessages,
          eq(schema.channelMessages.id, schema.emailAlertOccasions.channelMessageId),
        )
        .where(eq(schema.channelMessages.familyId, family.familyId)),
    ).resolves.toEqual([{ channelMessageId: rows[0]?.id }]);
  });

  it('T4a: the same pair in two threads is two alerts', async () => {
    const h = harness();
    const outcomes = await sweep(h, [inbound('k1', 't-a', 0), inbound('k2', 't-b', 10)]);
    expect(alerts(outcomes)).toEqual(['sent', 'sent']);
    expect(h.transport.sent).toHaveLength(2);
  });

  it('T4b: a cancellation of the occasion already told is told', async () => {
    const h = harness({
      k2: classified({ kind: 'cancellation', originalTime: SATURDAY, newTime: null }, 'k2'),
    });
    const outcomes = await sweep(h, [inbound('k1', 't-swim', 0), inbound('k2', 't-swim', 10)]);
    expect(alerts(outcomes)).toEqual(['sent', 'sent']);
    expect(h.transport.sent).toHaveLength(2);
  });

  it('T4c: a location-only move at the same instant is told', async () => {
    const h = harness({
      k2: classified(
        {
          kind: 'reschedule',
          originalTime: SATURDAY,
          newTime: SATURDAY,
          location: 'the north pool',
        },
        'k2',
      ),
    });
    const outcomes = await sweep(h, [inbound('k1', 't-swim', 0), inbound('k2', 't-swim', 10)]);
    expect(alerts(outcomes)).toEqual(['sent', 'sent']);
    expect(h.writer.seen).toHaveLength(2);
  });

  it('T4d: a second receipt for the same class in one thread refreshes its booking and is not told again', async () => {
    vi.stubEnv('BOOKED_DETECTION_ENABLED', 'true');
    const receipt = (messageId: string) =>
      classified({ kind: 'booking_confirmation', title: 'Swim Level 2' }, messageId);
    const h = harness({ k1: receipt('k1'), k2: receipt('k2') });

    const outcomes = await sweep(h, [inbound('k1', 't-swim', 0), inbound('k2', 't-swim', 10)]);

    expect(outcomes).toEqual([
      { alert: 'sent', booking: 'recorded', going: 'going_dark' },
      { alert: 'already_sent', booking: 'refreshed', going: null },
    ]);
    expect(h.transport.sent).toHaveLength(1);
    await expect(bookingRows()).resolves.toHaveLength(1);

    // The control: the same two receipts in two threads are two texts.
    const control = harness({ k3: receipt('k3'), k4: receipt('k4') });
    await expect(
      sweep(control, [inbound('k3', 't-c', 0), inbound('k4', 't-d', 10)]).then(alerts),
    ).resolves.toEqual(['sent', 'sent']);
  });

  it('T4e: a cancellation already told, read again, still closes a booking made since', async () => {
    vi.stubEnv('BOOKED_DETECTION_ENABLED', 'true');
    const cancellation = (messageId: string) =>
      classified(
        { kind: 'cancellation', title: 'Swim Level 2', originalTime: SATURDAY, newTime: null },
        messageId,
      );
    const receipt = classified({ kind: 'booking_confirmation', title: 'Swim Level 2' }, 'r1');
    const h = harness({ c1: cancellation('c1'), r1: receipt, c2: cancellation('c2') });

    await expect(sweep(h, [inbound('c1', 't-off', 0)]).then(alerts)).resolves.toEqual(['sent']);
    await expect(sweep(h, [inbound('r1', 't-receipt', 5)]).then(alerts)).resolves.toEqual(['sent']);
    // The control: the receipt left one open booking for the class.
    await expect(bookingRows().then((rows) => rows.map((r) => r.cancelledAt))).resolves.toEqual([
      null,
    ]);

    // The provider repeats the cancellation in the first thread: the same news, so no text,
    // and the booking made since is still closed.
    await expect(sweep(h, [inbound('c2', 't-off', 10)]).then(alerts)).resolves.toEqual([
      'already_sent',
    ]);
    expect(h.transport.sent).toHaveLength(2);
    await expect(bookingRows().then((rows) => rows.map((r) => r.cancelledAt))).resolves.toEqual([
      NOW,
    ]);
  });

  it("T10: a parent's 'not mine' on an alert names the Gmail message that told it", async () => {
    integrationId = await seedIntegration(
      db.database,
      family.familyId,
      family.parentUserId,
      'gmail',
    );
    const h = harness();
    await expect(
      sweep(h, [inbound('k1', 't-swim', 0), inbound('k2', 't-swim', 10)]).then(alerts),
    ).resolves.toEqual(['sent', 'already_sent']);
    const [row] = await alertRows();
    if (row === undefined) throw new Error('the sent alert left no row');

    await expect(
      untrackItem(db.database, {
        familyId: family.familyId,
        actorUserId: family.parentUserId,
        target: { kind: 'channel_message', id: row.id },
        now: NOW,
        kind: null,
      }),
    ).resolves.toMatchObject({ outcome: 'untracked', seenIn: 'gmail' });
    // k2 is the message that was told (newest first), and the verdict names it.
    await expect(
      db.database
        .select({
          itemKey: schema.kidRelevanceVerdicts.itemKey,
          integrationId: schema.kidRelevanceVerdicts.integrationId,
        })
        .from(schema.kidRelevanceVerdicts)
        .where(eq(schema.kidRelevanceVerdicts.familyId, family.familyId)),
    ).resolves.toEqual([{ itemKey: 'k2', integrationId }]);
  });

  it('T7: an earlier text for this occasion that FAILED is named, and nothing is re-sent', async () => {
    // An earlier message in the thread told this occasion; this one is a different message.
    async function prior(threadId: string, status: 'failed' | 'sent') {
      const [row] = await db.database
        .insert(schema.channelMessages)
        .values({
          familyId: family.familyId,
          parentUserId: family.parentUserId,
          channel: 'sms',
          direction: 'out',
          category: 'email_alert',
          templateKey: EMAIL_ALERT_TEMPLATE_KEY,
          dedupeKey: `email_alert:${integrationId}:earlier-${threadId}`,
          status,
          sentAt: NOW,
        })
        .returning({ id: schema.channelMessages.id });
      if (row === undefined) throw new Error('the prior alert row was not written');
      await db.database.insert(schema.emailAlertOccasions).values({
        occasionKey: emailAlertOccasionKey(
          integrationId,
          threadId,
          emailAlertOccasion(extraction(), 'k1'),
        ),
        channelMessageId: row.id,
      });
    }

    await prior('t-x', 'failed');
    const failed = harness();
    await expect(sweep(failed, [inbound('k1', 't-x', 0)]).then(alerts)).resolves.toEqual([
      'occasion_send_failed',
    ]);
    expect(failed.writer.seen).toEqual([]);
    expect(failed.transport.sent).toEqual([]);

    await prior('t-s', 'sent');
    const told = harness();
    await expect(sweep(told, [inbound('k1', 't-s', 0)]).then(alerts)).resolves.toEqual([
      'already_sent',
    ]);
    expect(told.writer.seen).toEqual([]);

    const fresh = harness();
    await expect(sweep(fresh, [inbound('k1', 't-y', 0)]).then(alerts)).resolves.toEqual(['sent']);
    expect(fresh.transport.sent).toHaveLength(1);
  });
});

describe('the occasion claim', () => {
  it('T11: a claim the read could not see wins, and the losing alert row is taken back out', async () => {
    // A claim held by a row that is not a consumed send stands in for a concurrent sweep's
    // claim the read could not see yet: only the insert can catch it.
    const [holder] = await db.database
      .insert(schema.channelMessages)
      .values({
        familyId: family.familyId,
        parentUserId: family.parentUserId,
        channel: 'sms',
        direction: 'out',
        category: 'email_alert',
        templateKey: EMAIL_ALERT_TEMPLATE_KEY,
        dedupeKey: null,
        status: 'suppressed_quiet_hours',
      })
      .returning({ id: schema.channelMessages.id });
    if (holder === undefined) throw new Error('the holder row was not written');
    await db.database.insert(schema.emailAlertOccasions).values({
      occasionKey: emailAlertOccasionKey(
        integrationId,
        't-race',
        emailAlertOccasion(extraction(), 'k1'),
      ),
      channelMessageId: holder.id,
    });

    const h = harness();
    await expect(sweep(h, [inbound('k1', 't-race', 0)]).then(alerts)).resolves.toEqual([
      'already_sent',
    ]);
    // The read missed it (the writer ran) and the claim caught it: nothing sent, no new row.
    expect(h.writer.seen).toHaveLength(1);
    expect(h.transport.sent).toEqual([]);
    await expect(alertRows().then((rows) => rows.map((r) => r.id))).resolves.toEqual([holder.id]);

    // The control: the same message in another thread is told.
    await expect(sweep(h, [inbound('k1', 't-free', 0)]).then(alerts)).resolves.toEqual(['sent']);
  });

  it('T12: migration 0203 applies a second time over itself', async () => {
    await expect(db.applyMigration('0203_email_alert_occasions.sql')).resolves.toBeUndefined();
    const result = await db.client.query<{ name: string | null }>(
      "select to_regclass('email_alert_occasions')::text as name",
    );
    expect(result.rows).toEqual([{ name: 'email_alert_occasions' }]);
  });
});

describe('emailAlertOccasion (T5)', () => {
  const occasion = (over: Parameters<typeof extraction>[0], messageId = 'a') =>
    emailAlertOccasion(extraction(over), messageId);

  it('a reminder of an announced instant is the same occasion, in any offset', () => {
    expect(occasion({ kind: 'new_event', newTime: SATURDAY })).toBe(
      occasion(
        { kind: 'reminder_only', originalTime: '2026-11-14T09:00:00-07:00', newTime: null },
        'b',
      ),
    );
  });

  it('a cancellation, a move, and a move elsewhere are each new news', () => {
    const announced = occasion({ kind: 'new_event', newTime: SATURDAY });
    const cancelled = occasion({ kind: 'cancellation', originalTime: SATURDAY, newTime: null });
    const movedHere = occasion({
      kind: 'reschedule',
      originalTime: SATURDAY,
      newTime: SATURDAY,
      location: 'North Pool',
    });
    const movedThere = occasion({
      kind: 'reschedule',
      originalTime: SATURDAY,
      newTime: SATURDAY,
      location: 'East Pool',
    });
    const movedLater = occasion({
      kind: 'reschedule',
      originalTime: SATURDAY,
      newTime: '2026-11-15T16:00:00.000Z',
    });
    expect(new Set([announced, cancelled, movedHere, movedThere, movedLater]).size).toBe(5);
    // Case and padding of the place are not a different place.
    expect(
      occasion({
        kind: 'reschedule',
        originalTime: SATURDAY,
        newTime: SATURDAY,
        location: '  north pool ',
      }),
    ).toBe(movedHere);
  });

  it('an offset-less time is not read in the host zone: it falls back to the message', () => {
    const offsetless = occasion({ kind: 'new_event', newTime: '2026-11-14T16:00:00' });
    expect(offsetless).not.toBe(occasion({ kind: 'new_event', newTime: SATURDAY }));
    expect(offsetless).toBe(occasion({ kind: 'new_event', newTime: null }));
  });

  it('with no instant, a matched event joins two messages and a message id keeps them apart', () => {
    const ref: CorrelatedEventRef = { table: 'family_events', id: randomUUID() };
    expect(occasion({ newTime: null, matchedEventRef: ref }, 'a')).toBe(
      occasion({ newTime: null, matchedEventRef: ref }, 'b'),
    );
    expect(occasion({ newTime: null }, 'a')).toBe(occasion({ newTime: null }, 'a'));
    expect(occasion({ newTime: null }, 'a')).not.toBe(occasion({ newTime: null }, 'b'));
  });

  it('the key carries no title and no place (rule #1: dedupe keys are never redacted)', () => {
    const moved = extraction({
      kind: 'reschedule',
      originalTime: SATURDAY,
      newTime: SATURDAY,
      location: 'North Pool',
    });
    const key = emailAlertOccasionKey(integrationId, 't-1', emailAlertOccasion(moved, 'k1'));
    expect(key.startsWith(`email_alert_occasion:${integrationId}:t-1:`)).toBe(true);
    expect(key.toLowerCase()).not.toContain('north pool');
    expect(key.toLowerCase()).not.toContain('swim');
  });
});
