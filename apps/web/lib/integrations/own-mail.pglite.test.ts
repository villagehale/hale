import { createHash, randomUUID } from 'node:crypto';
import { schema } from '@hale/db';
import type { IngestedEventPayload } from '@hale/tools-contracts';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeTransport } from '~/lib/channel/intake/transport';
import { readDueBookings } from '~/lib/integrations/booking';
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
  vi.stubEnv('APP_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
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

async function sync(
  h: Harness,
  messages: readonly FakeMessage[],
  enqueued: IngestedEventPayload[] = [],
) {
  const deps: SyncDeps = {
    googleFetch: gmail(messages),
    enqueue: async (event) => {
      enqueued.push(event);
    },
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
      notKid: 0,
      unjudged: 0,
      unjudgedNoJudge: 0,
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

    // The parent's own mail stops at the sync, named in its log line; only k1 is an envelope.
    expect(alerts(result.emailAlerts)).toEqual(['sent']);
    expect(console.info).toHaveBeenCalledWith(
      { integrationId, skippedOwnMail: { own_mail: 1, draft: 1 } },
      'connector sync: the parent’s own gmail skipped before ingest',
    );
    expect(h.classified).toEqual(['k1']);
    expect(h.writer.seen).toHaveLength(1);
    expect(h.transport.sent).toHaveLength(1);
    await expect(alertRows()).resolves.toHaveLength(1);
    // Every message here carried labels, so none is counted as unlabelled (T2 is the control).
    expect(console.info).not.toHaveBeenCalledWith(
      expect.objectContaining({ labelsMissing: expect.anything() }),
      expect.anything(),
    );
  });

  it('T13: the parent’s SENT and DRAFT mail is never enqueued for ingestion; inbound mail is', async () => {
    const h = harness();
    const enqueued: IngestedEventPayload[] = [];
    await sync(
      h,
      [
        { id: 's1', threadId: 't-s1', labelIds: ['SENT'], internalDate: at(1) },
        { id: 'd1', threadId: 't-d1', labelIds: ['DRAFT'], internalDate: at(2) },
        { id: 'k1', threadId: 't-k1', labelIds: ['INBOX'], internalDate: at(3) },
      ],
      enqueued,
    );

    // The positive control is k1: the one payload enqueued, and the one text.
    expect(enqueued.map((event) => event.payload.id)).toEqual(['k1']);
    expect(h.transport.sent).toHaveLength(1);
  });

  it('T2: an envelope built with no label read is refused; a 200 with no labelIds is read as no labels', async () => {
    const direct = harness();
    const { labelIds: _unread, ...unlabelled } = inbound('u1', 't-u1', 1);
    await expect(
      sweep(direct, [unlabelled, inbound('k1', 't-k1', 2)]).then(alerts),
    ).resolves.toEqual(['labels_unread', 'sent']);
    expect(direct.classified).toEqual(['k1']);

    // Gmail omits an empty repeated field: archived, read mail with no label at all.
    const viaSync = harness();
    const result = await sync(viaSync, [{ id: 'a1', threadId: 't-a1', internalDate: at(3) }]);
    expect(alerts(result.emailAlerts)).toEqual(['sent']);
    expect(viaSync.classified).toEqual(['a1']);
    // Read as inbound, and counted under its own name.
    expect(console.info).toHaveBeenCalledWith(
      { integrationId, labelsMissing: 1 },
      'connector sync: gmail messages with no labels read as inbound',
    );
  });

  it('T3: three autosaves of one draft (three message ids) are zero alerts', async () => {
    const h = harness();
    const result = await sync(h, [
      { id: 'd1', threadId: 't-draft', labelIds: ['DRAFT'], internalDate: at(1) },
      { id: 'd2', threadId: 't-draft', labelIds: ['DRAFT'], internalDate: at(2) },
      { id: 'd3', threadId: 't-draft', labelIds: ['DRAFT'], internalDate: at(3) },
      { id: 'k1', threadId: 't-k1', labelIds: ['INBOX'], internalDate: at(4) },
    ]);

    expect(alerts(result.emailAlerts)).toEqual(['sent']);
    expect(console.info).toHaveBeenCalledWith(
      { integrationId, skippedOwnMail: { own_mail: 0, draft: 3 } },
      'connector sync: the parent’s own gmail skipped before ingest',
    );
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

    // Oldest first: k1 is told, k2 is the same news.
    expect(alerts(outcomes)).toEqual(['sent', 'already_sent']);
    expect(h.classified).toEqual(['k1', 'k2']);
    expect(h.writer.seen).toHaveLength(1);
    expect(h.transport.sent).toHaveLength(1);
    const rows = await alertRows();
    expect(rows.map((r) => r.dedupeKey)).toEqual([`email_alert:${integrationId}:k1`]);
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
    await expect(sweep(h, [inbound('k1', 't-swim', 0)]).then(alerts)).resolves.toEqual(['sent']);
    await expect(sweep(h, [inbound('k2', 't-swim', 10)]).then(alerts)).resolves.toEqual(['sent']);
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
    await expect(sweep(h, [inbound('k1', 't-swim', 0)]).then(alerts)).resolves.toEqual(['sent']);
    await expect(sweep(h, [inbound('k2', 't-swim', 10)]).then(alerts)).resolves.toEqual(['sent']);
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

  it('T4f: a class cancelled and then put back on at the same time is told again; a repeat is not', async () => {
    const on = (messageId: string) =>
      classified({ kind: 'new_event', newTime: SATURDAY }, messageId);
    const off = (messageId: string) =>
      classified({ kind: 'cancellation', originalTime: SATURDAY, newTime: null }, messageId);
    const h = harness({ k1: on('k1'), k2: off('k2'), k3: on('k3'), k4: on('k4'), k5: off('k5') });
    const one = (messageId: string, minute: number) =>
      sweep(h, [inbound(messageId, 't-swim', minute)]).then(alerts);

    await expect(one('k1', 0)).resolves.toEqual(['sent']);
    await expect(one('k2', 10)).resolves.toEqual(['sent']);
    // Back on: the parent's last word from Hale must not stay "cancelled".
    await expect(one('k3', 20)).resolves.toEqual(['sent']);
    // The control: the same "on" again is a repeat of what was just told.
    await expect(one('k4', 30)).resolves.toEqual(['already_sent']);
    // And off a second time is a change again, not the first cancellation's repeat.
    await expect(one('k5', 40)).resolves.toEqual(['sent']);
    expect(h.transport.sent).toHaveLength(4);
    expect(h.writer.seen).toHaveLength(4);
  });

  it('T4h: a cancellation that never reached the parent does not make the next announcement news', async () => {
    const on = (messageId: string) =>
      classified({ kind: 'new_event', newTime: SATURDAY }, messageId);
    const off = (messageId: string) =>
      classified({ kind: 'cancellation', originalTime: SATURDAY, newTime: null }, messageId);
    const byMessage = { k1: on('k1'), k2: off('k2'), k3: on('k3'), k4: off('k4') };
    const h = harness(byMessage);
    const refused = harness(byMessage);
    refused.transport.send = async () => {
      throw new Error('provider refused');
    };
    const one = (harnessed: Harness, messageId: string, minute: number) =>
      sweep(harnessed, [inbound(messageId, 't-swim', minute)]).then(alerts);

    await expect(one(h, 'k1', 0)).resolves.toEqual(['sent']);
    await expect(one(refused, 'k2', 10)).resolves.toEqual(['send_failed']);
    // The parent's last word is still "on": the same "on" again is a repeat.
    await expect(one(h, 'k3', 20)).resolves.toEqual(['already_sent']);
    // The failed cancellation, read again, is named rather than re-sent.
    await expect(one(h, 'k4', 30)).resolves.toEqual(['occasion_send_failed']);
    expect(h.transport.sent).toHaveLength(1);
  });

  it('T4g: another date told in the same thread does not make a repeat of this one news', async () => {
    const sunday = '2026-11-15T16:00:00.000Z';
    const h = harness({
      k1: classified({ kind: 'new_event', newTime: SATURDAY }, 'k1'),
      k2: classified({ kind: 'new_event', newTime: sunday }, 'k2'),
      k3: classified({ kind: 'reminder_only', originalTime: SATURDAY, newTime: null }, 'k3'),
    });
    const one = (messageId: string, minute: number) =>
      sweep(h, [inbound(messageId, 't-swim', minute)]).then(alerts);

    await expect(one('k1', 0)).resolves.toEqual(['sent']);
    await expect(one('k2', 10)).resolves.toEqual(['sent']);
    await expect(one('k3', 20)).resolves.toEqual(['already_sent']);
    expect(h.transport.sent).toHaveLength(2);
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
    // k1 is the message that was told (oldest first), and the verdict names it.
    await expect(
      db.database
        .select({
          itemKey: schema.kidRelevanceVerdicts.itemKey,
          integrationId: schema.kidRelevanceVerdicts.integrationId,
        })
        .from(schema.kidRelevanceVerdicts)
        .where(eq(schema.kidRelevanceVerdicts.familyId, family.familyId)),
    ).resolves.toEqual([{ itemKey: 'k1', integrationId }]);
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

/**
 * THE PARENT'S LAST WORD FROM HALE IS THE NEWEST EMAIL'S STATE, AND EVERY BOOKING EFFECT
 * HAPPENS EXACTLY ONCE. A sweep is handled oldest first, so the claims inside one sweep are
 * written in the order the emails were sent. An email older than what the thread has
 * already told about the same instant, read in a LATER sweep, is `stale_news`: it is not
 * texted, and its booking effects happen as for any email.
 */
describe('the emails’ own order decides the last word', () => {
  const SUNDAY = '2026-11-15T16:00:00.000Z';
  const on = (messageId: string, title = 'Swim Level 2') =>
    classified({ kind: 'new_event', title, newTime: SATURDAY }, messageId);
  const reminder = (messageId: string) =>
    classified(
      { kind: 'reminder_only', title: 'Swim Level 2', originalTime: SATURDAY, newTime: null },
      messageId,
    );
  const off = (messageId: string) =>
    classified(
      { kind: 'cancellation', title: 'Swim Level 2', originalTime: SATURDAY, newTime: null },
      messageId,
    );
  const receipt = (messageId: string) =>
    classified({ kind: 'booking_confirmation', title: 'Swim Level 2' }, messageId);
  const moved = (messageId: string) =>
    classified(
      { kind: 'reschedule', title: 'Swim Level 2', originalTime: SATURDAY, newTime: SUNDAY },
      messageId,
    );
  const cancelledAt = () => bookingRows().then((rows) => rows.map((r) => r.cancelledAt));
  const kindsTold = (h: Harness) => h.writer.seen.map((facts) => facts.email.kind);

  beforeEach(() => {
    vi.stubEnv('BOOKED_DETECTION_ENABLED', 'true');
  });

  it('T15: a cancellation and another class at the same instant, in one sweep, are both told and the cancelled booking closes', async () => {
    const h = harness({ r1: receipt('r1'), c1: off('c1'), n1: on('n1', 'Swim Level 3') });
    await expect(sweep(h, [inbound('r1', 't-receipt', 0)]).then(alerts)).resolves.toEqual(['sent']);
    // The control: the receipt left Level 2 open, so the closer has something to close.
    await expect(cancelledAt()).resolves.toEqual([null]);

    // Handed newest first; the sweep reads them in the order they were sent.
    await expect(
      sweep(h, [inbound('n1', 't-swim', 20), inbound('c1', 't-swim', 10)]).then(alerts),
    ).resolves.toEqual(['sent', 'sent']);
    expect(kindsTold(h)).toEqual(['booking_confirmation', 'cancellation', 'new_event']);
    await expect(cancelledAt()).resolves.toEqual([NOW]);
  });

  it('T16: a receipt and a newer move of the same class, in one sweep, record the booking and tell the move', async () => {
    const h = harness({ r1: receipt('r1'), m1: moved('m1') });

    await expect(
      sweep(h, [inbound('m1', 't-swim', 20), inbound('r1', 't-swim', 10)]).then(alerts),
    ).resolves.toEqual(['sent', 'sent']);
    expect(kindsTold(h)).toEqual(['booking_confirmation', 'reschedule']);
    await expect(cancelledAt()).resolves.toEqual([null]);
  });

  it('T17: after "on" was told, an older cancellation and a newer "back on" in one sweep leave the last word "on"', async () => {
    const h = harness({ k0: on('k0'), k1: off('k1'), k2: on('k2'), k3: on('k3'), k4: off('k4') });
    await expect(sweep(h, [inbound('k0', 't-swim', 0)]).then(alerts)).resolves.toEqual(['sent']);

    await expect(
      sweep(h, [inbound('k2', 't-swim', 20), inbound('k1', 't-swim', 10)]).then(alerts),
    ).resolves.toEqual(['sent', 'sent']);
    expect(kindsTold(h)).toEqual(['new_event', 'cancellation', 'new_event']);
    // The last word is "on": the same "on" again is a repeat of it.
    await expect(sweep(h, [inbound('k3', 't-swim', 30)]).then(alerts)).resolves.toEqual([
      'already_sent',
    ]);
    // The control: a newer cancellation is news.
    await expect(sweep(h, [inbound('k4', 't-swim', 40)]).then(alerts)).resolves.toEqual(['sent']);
    expect(h.transport.sent).toHaveLength(4);
  });

  it('T18: after "on" was told, an older "on" and a newer cancellation in one sweep leave the last word "cancelled", and "on" is not texted again', async () => {
    const h = harness({
      k0: on('k0'),
      k1: reminder('k1'),
      k2: off('k2'),
      k3: off('k3'),
      k4: on('k4'),
    });
    await expect(sweep(h, [inbound('k0', 't-swim', 0)]).then(alerts)).resolves.toEqual(['sent']);

    await expect(
      sweep(h, [inbound('k2', 't-swim', 20), inbound('k1', 't-swim', 10)]).then(alerts),
    ).resolves.toEqual(['already_sent', 'sent']);
    expect(kindsTold(h)).toEqual(['new_event', 'cancellation']);
    // The last word is "cancelled": the same cancellation again is a repeat of it.
    await expect(sweep(h, [inbound('k3', 't-swim', 30)]).then(alerts)).resolves.toEqual([
      'already_sent',
    ]);
    // The control: a newer "on" is the class back on, and is told.
    await expect(sweep(h, [inbound('k4', 't-swim', 40)]).then(alerts)).resolves.toEqual(['sent']);
    expect(h.transport.sent).toHaveLength(3);
  });

  it('T19: a cancellation older than what the thread last told, read in a later sweep, is not texted and still closes a booking from an older email', async () => {
    const h = harness({ r0: receipt('r0'), n1: on('n1', 'Swim Level 3'), c1: off('c1') });
    await expect(sweep(h, [inbound('r0', 't-receipt', 0)]).then(alerts)).resolves.toEqual(['sent']);
    await expect(sweep(h, [inbound('n1', 't-swim', 20)]).then(alerts)).resolves.toEqual(['sent']);
    await expect(cancelledAt()).resolves.toEqual([null]);

    await expect(sweep(h, [inbound('c1', 't-swim', 10)]).then(alerts)).resolves.toEqual([
      'stale_news',
    ]);
    expect(h.transport.sent).toHaveLength(2);
    await expect(cancelledAt()).resolves.toEqual([NOW]);
    // Named in the log by family id alone: no Gmail message id beside it.
    expect(console.info).toHaveBeenCalledWith(
      { familyId: family.familyId },
      'email alert: older than what this thread last told',
    );
  });

  it('T20: a stale cancellation leaves open a booking recorded from a newer email; a newer cancellation closes it', async () => {
    const h = harness({ r1: receipt('r1'), c1: off('c1'), c2: off('c2') });
    await expect(sweep(h, [inbound('r1', 't-swim', 30)]).then(alerts)).resolves.toEqual(['sent']);

    await expect(sweep(h, [inbound('c1', 't-swim', 20)]).then(alerts)).resolves.toEqual([
      'stale_news',
    ]);
    await expect(cancelledAt()).resolves.toEqual([null]);

    // The control: a cancellation newer than the receipt is told and closes it.
    await expect(sweep(h, [inbound('c2', 't-swim', 40)]).then(alerts)).resolves.toEqual(['sent']);
    await expect(cancelledAt()).resolves.toEqual([NOW]);
    expect(kindsTold(h)).toEqual(['booking_confirmation', 'cancellation']);
  });

  it('T20b: a booking refreshed by a newer receipt is not closed by a cancellation older than that receipt', async () => {
    const h = harness({ r1: receipt('r1'), r2: receipt('r2'), c1: off('c1'), c2: off('c2') });
    await expect(sweep(h, [inbound('r1', 't-first', 10)])).resolves.toEqual([
      { alert: 'sent', booking: 'recorded', going: 'going_dark' },
    ]);
    await expect(sweep(h, [inbound('r2', 't-again', 30)])).resolves.toEqual([
      { alert: 'sent', booking: 'refreshed', going: 'going_dark' },
    ]);

    // Newer than the first receipt, older than the second: the booking stays open.
    await expect(sweep(h, [inbound('c1', 't-again', 20)]).then(alerts)).resolves.toEqual([
      'stale_news',
    ]);
    await expect(cancelledAt()).resolves.toEqual([null]);
    // The control: newer than both, it closes.
    await expect(sweep(h, [inbound('c2', 't-again', 40)]).then(alerts)).resolves.toEqual(['sent']);
    await expect(cancelledAt()).resolves.toEqual([NOW]);
  });

  it('T21: a stale receipt is not texted and still records its booking', async () => {
    const h = harness({ c1: off('c1'), r1: receipt('r1'), r2: receipt('r2') });
    await expect(sweep(h, [inbound('c1', 't-swim', 20)]).then(alerts)).resolves.toEqual(['sent']);

    await expect(sweep(h, [inbound('r1', 't-swim', 10)])).resolves.toEqual([
      { alert: 'stale_news', booking: 'recorded', going: null },
    ]);
    expect(h.transport.sent).toHaveLength(1);
    await expect(bookingRows()).resolves.toHaveLength(1);

    // The control: the same receipt newer than the cancellation is the class back on, told.
    await expect(sweep(h, [inbound('r2', 't-swim', 30)]).then(alerts)).resolves.toEqual(['sent']);
    expect(h.transport.sent).toHaveLength(2);
  });

  it('T20c: an older receipt read late does not make the booking older than its newest receipt', async () => {
    const h = harness({ r2: receipt('r2'), r1: receipt('r1'), c1: off('c1'), c2: off('c2') });
    await expect(sweep(h, [inbound('r2', 't-swim', 30)])).resolves.toEqual([
      { alert: 'sent', booking: 'recorded', going: 'going_dark' },
    ]);
    // The same receipt state again is a repeat, not news; it still refreshes the booking.
    await expect(sweep(h, [inbound('r1', 't-swim', 10)])).resolves.toEqual([
      { alert: 'already_sent', booking: 'refreshed', going: null },
    ]);

    // Newer than the late receipt, older than the newest one: the booking stays open.
    await expect(sweep(h, [inbound('c1', 't-swim', 20)]).then(alerts)).resolves.toEqual([
      'stale_news',
    ]);
    await expect(cancelledAt()).resolves.toEqual([null]);
    // The control: newer than both receipts, it closes.
    await expect(sweep(h, [inbound('c2', 't-swim', 40)]).then(alerts)).resolves.toEqual(['sent']);
    await expect(cancelledAt()).resolves.toEqual([NOW]);
  });

  it('T21b: a booking recorded from a stale receipt is not closed by a cancellation older than that receipt', async () => {
    // The thread's last word is newer than the receipt and is not a cancellation: the class
    // moved onto this Saturday. (After a told cancellation the booking is born closed: T25.)
    const movedHere = classified(
      { kind: 'reschedule', title: 'Swim Level 2', originalTime: SUNDAY, newTime: SATURDAY },
      'm1',
    );
    const h = harness({ m1: movedHere, r1: receipt('r1'), c0: off('c0'), c2: off('c2') });
    await expect(sweep(h, [inbound('m1', 't-swim', 20)]).then(alerts)).resolves.toEqual(['sent']);
    await expect(sweep(h, [inbound('r1', 't-swim', 10)])).resolves.toEqual([
      { alert: 'stale_news', booking: 'recorded', going: null },
    ]);

    // Another thread, an email older than the receipt: the booking stays open.
    await expect(sweep(h, [inbound('c0', 't-early', 5)]).then(alerts)).resolves.toEqual(['sent']);
    await expect(cancelledAt()).resolves.toEqual([null]);
    // The control: a cancellation newer than the receipt closes it.
    await expect(sweep(h, [inbound('c2', 't-late', 15)]).then(alerts)).resolves.toEqual(['sent']);
    await expect(cancelledAt()).resolves.toEqual([NOW]);
  });

  it('T24: the backfill keeps each email’s own time, on the booking it records and on the cancellation it reads', async () => {
    const h = harness({ r1: receipt('r1'), c0: off('c0'), c2: off('c2') });
    const backfill = (envelope: GmailAlertEnvelope) =>
      alertParentForGmailSweep(
        db.database,
        {
          familyId: family.familyId,
          parentUserId: family.parentUserId,
          integrationId,
          seeding: false,
          backfill: true,
          envelopes: [envelope],
          now: NOW,
        },
        h.ports,
      ).then(alerts);

    await expect(backfill(inbound('r1', 't-old', 10))).resolves.toEqual(['backfill_suppressed']);
    // A live cancellation older than the backfilled receipt leaves it open.
    await expect(sweep(h, [inbound('c0', 't-early', 5)]).then(alerts)).resolves.toEqual(['sent']);
    await expect(cancelledAt()).resolves.toEqual([null]);
    // The control: a backfilled cancellation newer than the receipt closes it.
    await expect(backfill(inbound('c2', 't-old', 15))).resolves.toEqual(['backfill_suppressed']);
    await expect(cancelledAt()).resolves.toEqual([NOW]);
  });

  it('T22: "last" is the order the emails were received in, not the order their claims were written', async () => {
    const h = harness({
      a: on('a'),
      b: classified({ kind: 'new_event', title: 'Swim Level 2', newTime: SUNDAY }, 'b'),
      c: moved('c'),
      d: moved('d'),
    });
    await expect(sweep(h, [inbound('a', 't-swim', 30)]).then(alerts)).resolves.toEqual(['sent']);
    // Another instant, received earlier and claimed later.
    await expect(sweep(h, [inbound('b', 't-swim', 20)]).then(alerts)).resolves.toEqual(['sent']);

    // About both instants: the newest email about them is `a` (minute 30), so a move from
    // minute 25 is older than the thread's last word.
    await expect(sweep(h, [inbound('c', 't-swim', 25)]).then(alerts)).resolves.toEqual([
      'stale_news',
    ]);
    // The control: the same move from minute 35 is news.
    await expect(sweep(h, [inbound('d', 't-swim', 35)]).then(alerts)).resolves.toEqual(['sent']);
    expect(h.transport.sent).toHaveLength(3);
  });

  it('T23: an anchor key is a keyed index, never a plain digest of the instant', async () => {
    const h = harness({ k1: on('k1'), k2: on('k2') });
    await expect(sweep(h, [inbound('k1', 't-swim', 0)]).then(alerts)).resolves.toEqual(['sent']);
    const [claim] = await db.database
      .select({ anchorKeys: schema.emailAlertOccasions.anchorKeys })
      .from(schema.emailAlertOccasions)
      .innerJoin(
        schema.channelMessages,
        eq(schema.channelMessages.id, schema.emailAlertOccasions.channelMessageId),
      )
      .where(eq(schema.channelMessages.familyId, family.familyId));
    const plain = createHash('sha256').update(SATURDAY).digest('hex').slice(0, 32);
    // One for the instant, one for this class at the instant.
    expect(claim?.anchorKeys).toHaveLength(2);
    expect(claim?.anchorKeys?.some((key) => key.includes(plain))).toBe(false);
    expect(claim?.anchorKeys?.some((key) => key.includes(integrationId))).toBe(false);
    expect(claim?.anchorKeys?.some((key) => /swim|aspen/i.test(key))).toBe(false);
    // The control: the key still finds the claim, so the same "on" again is a repeat.
    await expect(sweep(h, [inbound('k2', 't-swim', 10)]).then(alerts)).resolves.toEqual([
      'already_sent',
    ]);
  });
});

/**
 * A BOOKING IS OPEN ONLY IF THE THREAD'S LAST WORD ABOUT ITS INSTANT IS NOT A NEWER
 * CANCELLATION. A receipt read after the parent was told the class is off, but sent before
 * that cancellation, is history: its booking is written closed at the cancellation's own
 * time, so no "how did it go?" is ever due for it.
 */
describe('a cancellation the parent was told outlives an older receipt read late', () => {
  const off = (messageId: string, title = 'Swim Level 2') =>
    classified({ kind: 'cancellation', title, originalTime: SATURDAY, newTime: null }, messageId);
  const receipt = (messageId: string) =>
    classified({ kind: 'booking_confirmation', title: 'Swim Level 2' }, messageId);
  const reminder = (messageId: string) =>
    classified(
      { kind: 'reminder_only', title: 'Swim Level 2', originalTime: SATURDAY, newTime: null },
      messageId,
    );
  const minute = (m: number) => new Date(Number(at(m)));
  const cancelledAt = () => bookingRows().then((rows) => rows.map((r) => r.cancelledAt));
  const SATURDAY_WINDOW = {
    floor: new Date('2026-11-14T00:00:00.000Z'),
    latest: new Date('2026-11-15T00:00:00.000Z'),
  };
  const trailOf = (bookingId: string) =>
    db.database
      .select({ action: schema.auditLog.actionTaken })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.targetId, bookingId))
      .then((rows) => rows.map((row) => row.action).sort());

  beforeEach(() => {
    vi.stubEnv('BOOKED_DETECTION_ENABLED', 'true');
  });

  it('T25: a receipt older than a told cancellation records its booking closed at the cancellation, and no ask is due', async () => {
    const h = harness({ c1: off('c1'), r1: receipt('r1') });
    await expect(sweep(h, [inbound('c1', 't-swim', 20)]).then(alerts)).resolves.toEqual(['sent']);
    await expect(bookingRows()).resolves.toHaveLength(0);

    await expect(sweep(h, [inbound('r1', 't-swim', 10)])).resolves.toEqual([
      { alert: 'stale_news', booking: 'recorded', going: null },
    ]);
    expect(h.transport.sent).toHaveLength(1);
    await expect(cancelledAt()).resolves.toEqual([minute(20)]);
    await expect(readDueBookings(db.database, family.familyId, SATURDAY_WINDOW)).resolves.toEqual(
      [],
    );
    const [booking] = await bookingRows();
    await expect(trailOf(booking?.id ?? '')).resolves.toEqual([
      'activity_booking_cancelled',
      'activity_booking_recorded',
    ]);
  });

  it('T25b: a receipt newer than the told cancellation is the class booked again, and its ask is due', async () => {
    const h = harness({ c1: off('c1'), r2: receipt('r2') });
    await expect(sweep(h, [inbound('c1', 't-swim', 20)]).then(alerts)).resolves.toEqual(['sent']);

    await expect(sweep(h, [inbound('r2', 't-swim', 30)])).resolves.toEqual([
      { alert: 'sent', booking: 'recorded', going: 'going_dark' },
    ]);
    await expect(cancelledAt()).resolves.toEqual([null]);
    const [booking] = await bookingRows();
    await expect(
      readDueBookings(db.database, family.familyId, SATURDAY_WINDOW).then((due) =>
        due.map((row) => row.bookingId),
      ),
    ).resolves.toEqual([booking?.id]);
  });

  it('T25c: after the class was told back on, an older receipt read late records an open booking', async () => {
    const h = harness({ c1: off('c1'), k2: reminder('k2'), r1: receipt('r1') });
    await expect(
      sweep(h, [inbound('c1', 't-swim', 20), inbound('k2', 't-swim', 30)]).then(alerts),
    ).resolves.toEqual(['sent', 'sent']);

    await expect(sweep(h, [inbound('r1', 't-swim', 10)])).resolves.toEqual([
      { alert: 'already_sent', booking: 'recorded', going: null },
    ]);
    await expect(cancelledAt()).resolves.toEqual([null]);
  });

  it('T25e: the backfill reads the same last word: an older receipt it records after a told cancellation is closed', async () => {
    const h = harness({ c1: off('c1'), r1: receipt('r1'), r2: receipt('r2') });
    const backfill = (envelope: GmailAlertEnvelope) =>
      alertParentForGmailSweep(
        db.database,
        {
          familyId: family.familyId,
          parentUserId: family.parentUserId,
          integrationId,
          seeding: false,
          backfill: true,
          envelopes: [envelope],
          now: NOW,
        },
        h.ports,
      );
    await expect(sweep(h, [inbound('c1', 't-swim', 20)]).then(alerts)).resolves.toEqual(['sent']);

    await expect(backfill(inbound('r1', 't-swim', 10))).resolves.toEqual([
      { alert: 'backfill_suppressed', booking: 'recorded', going: null },
    ]);
    await expect(cancelledAt()).resolves.toEqual([minute(20)]);
    // The control: a receipt in another thread has no told cancellation behind it.
    await expect(backfill(inbound('r2', 't-other', 10))).resolves.toEqual([
      { alert: 'backfill_suppressed', booking: 'recorded', going: null },
    ]);
    await expect(
      cancelledAt().then((rows) => rows.map((row) => row?.toISOString() ?? 'open').sort()),
    ).resolves.toEqual([minute(20).toISOString(), 'open']);
  });

  it('T25d: an older receipt read late that refreshes an open booking closes it at the told cancellation', async () => {
    const h = harness({ c1: off('c1'), r0: receipt('r0'), r1: receipt('r1') });
    await expect(sweep(h, [inbound('c1', 't-swim', 20)]).then(alerts)).resolves.toEqual(['sent']);
    // A receipt in another thread has no told cancellation behind it, so its booking is
    // open: the refresh below is what closes it.
    await expect(sweep(h, [inbound('r0', 't-first', 5)])).resolves.toEqual([
      { alert: 'sent', booking: 'recorded', going: 'going_dark' },
    ]);
    await expect(cancelledAt()).resolves.toEqual([null]);

    await expect(sweep(h, [inbound('r1', 't-swim', 10)])).resolves.toEqual([
      { alert: 'stale_news', booking: 'refreshed', going: null },
    ]);
    await expect(cancelledAt()).resolves.toEqual([minute(20)]);
    const [booking] = await bookingRows();
    await expect(trailOf(booking?.id ?? '')).resolves.toEqual([
      'activity_booking_cancelled',
      'activity_booking_recorded',
    ]);
  });

  it('T25g: with no sender on either email, the class is still read by its title, as the closer reads it', async () => {
    const h = harness({ c1: off('c1'), r1: receipt('r1') });
    const unsigned = (envelope: GmailAlertEnvelope) => ({ ...envelope, from: '' });
    await expect(sweep(h, [unsigned(inbound('c1', 't-swim', 20))]).then(alerts)).resolves.toEqual([
      'sent',
    ]);

    await expect(sweep(h, [unsigned(inbound('r1', 't-swim', 10))])).resolves.toEqual([
      { alert: 'stale_news', booking: 'recorded', going: null },
    ]);
    await expect(cancelledAt()).resolves.toEqual([minute(20)]);
  });

  it('T25f: a told cancellation of another class at the same instant leaves a late receipt open', async () => {
    const h = harness({
      c1: off('c1', 'Swim Level 1'),
      r1: receipt('r1'),
      r2: classified({ kind: 'booking_confirmation', title: 'Swim Level 1' }, 'r2'),
    });
    await expect(sweep(h, [inbound('c1', 't-swim', 20)]).then(alerts)).resolves.toEqual(['sent']);

    await expect(sweep(h, [inbound('r1', 't-swim', 10)])).resolves.toEqual([
      { alert: 'stale_news', booking: 'recorded', going: null },
    ]);
    await expect(cancelledAt()).resolves.toEqual([null]);
    // The control: a late receipt for the class that was cancelled is closed.
    await expect(sweep(h, [inbound('r2', 't-swim', 10)])).resolves.toEqual([
      { alert: 'stale_news', booking: 'recorded', going: null },
    ]);
    const byTitle = await bookingRows().then((rows) =>
      Object.fromEntries(rows.map((row) => [row.title, row.cancelledAt])),
    );
    expect(byTitle).toEqual({ 'Swim Level 1': minute(20), 'Swim Level 2': null });
  });

  it('T25h: a receipt newer than the told cancellation and never texted (the backfill) records an open booking', async () => {
    const h = harness({ c1: off('c1'), r3: receipt('r3') });
    await expect(sweep(h, [inbound('c1', 't-swim', 20)]).then(alerts)).resolves.toEqual(['sent']);

    // The backfill tells nothing, so the told cancellation stays the thread's last claim:
    // only the receipt's own newer time keeps the booking open. T25e is the older control.
    await expect(
      alertParentForGmailSweep(
        db.database,
        {
          familyId: family.familyId,
          parentUserId: family.parentUserId,
          integrationId,
          seeding: false,
          backfill: true,
          envelopes: [inbound('r3', 't-swim', 30)],
          now: NOW,
        },
        h.ports,
      ),
    ).resolves.toEqual([{ alert: 'backfill_suppressed', booking: 'recorded', going: null }]);
    expect(h.transport.sent).toHaveLength(1);
    await expect(cancelledAt()).resolves.toEqual([null]);
  });

  it('T25i: an older receipt read late refreshes a booking recorded from an email newer than the cancellation, and leaves it open', async () => {
    const h = harness({ c1: off('c1'), r0: receipt('r0'), r1: receipt('r1') });
    await expect(sweep(h, [inbound('c1', 't-swim', 20)]).then(alerts)).resolves.toEqual(['sent']);
    await expect(sweep(h, [inbound('r0', 't-other', 30)])).resolves.toEqual([
      { alert: 'sent', booking: 'recorded', going: 'going_dark' },
    ]);

    // The told cancellation is newer than this receipt but older than the email the row was
    // recorded from, so the refresh keeps it open (the closer's rule). T25d is the control
    // where the row's email is older than the cancellation and the refresh closes it.
    await expect(sweep(h, [inbound('r1', 't-swim', 10)])).resolves.toEqual([
      { alert: 'stale_news', booking: 'refreshed', going: null },
    ]);
    await expect(cancelledAt()).resolves.toEqual([null]);
    await expect(
      bookingRows().then((rows) => rows.map((row) => row.sourceReceivedAt)),
    ).resolves.toEqual([minute(30)]);
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
    await expect(db.applyMigration('0198_email_alert_occasions.sql')).resolves.toBeUndefined();
    const result = await db.client.query<{ name: string | null }>(
      "select to_regclass('email_alert_occasions')::text as name",
    );
    expect(result.rows).toEqual([{ name: 'email_alert_occasions' }]);
  });
});

describe('migration 0200', () => {
  it('T14: applies a second time over itself and leaves its three columns and the index', async () => {
    await expect(
      db.applyMigration('0200_email_alert_occasion_anchors.sql'),
    ).resolves.toBeUndefined();
    const result = await db.client.query<{
      type: string | null;
      received: string | null;
      source: string | null;
      idx: string | null;
    }>(
      `select
         (select data_type from information_schema.columns
           where table_name = 'email_alert_occasions' and column_name = 'anchor_keys') as type,
         (select data_type from information_schema.columns
           where table_name = 'email_alert_occasions' and column_name = 'received_at') as received,
         (select data_type from information_schema.columns
           where table_name = 'activity_bookings' and column_name = 'source_received_at') as source,
         to_regclass('email_alert_occasions_anchor_keys_idx')::text as idx`,
    );
    expect(result.rows).toEqual([
      {
        type: 'ARRAY',
        received: 'timestamp with time zone',
        source: 'timestamp with time zone',
        idx: 'email_alert_occasions_anchor_keys_idx',
      },
    ]);
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
