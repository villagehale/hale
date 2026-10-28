import { randomUUID } from 'node:crypto';
import { schema } from '@hale/db';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeTransport } from '~/lib/channel/intake/transport';
import { LinqSendError } from '~/lib/channel/linq/transport';
import { OPT_OUT_LINE } from '~/lib/channel/opt-out';
import { PROACTIVE_CATEGORY } from '~/lib/channel/outbound-gate';
import type { ExtractedEvent, ExtractionKind, SentinelClassification } from '~/lib/sentinel';
import { type ScriptedNoticeWriter, scriptedNoticeWriter } from '~/lib/testing/email-alert-notice';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import {
  EMAIL_ALERT_TEMPLATE_KEY,
  type EmailAlertOutcome,
  type EmailAlertPorts,
  type EmailAlertResult,
  type GmailAlertEnvelope,
  alertParentForEmail,
  alertParentForGmailSweep,
  emailAlertDedupeKey,
  emailAlertOfferDraft,
} from './email-alert';
import { EMAIL_ALERT_OFFER_TTL_MS } from './email-alert-offer';
import type { EmailAlertNotice } from './email-alert-notice';
import { GOING_COUNT_ENABLED_ENV, sessionKey } from './going';

/**
 * The join between the sentinel and the outbound chokepoint, against the REAL DDL.
 *
 * pglite rather than a Drizzle chain fake, because the two things most likely to be wrong
 * here are both SQL: the partial unique index on `channel_messages.dedupe_key` (which is
 * what makes "at most one text per email" true under a re-fired cron) and the WHERE clause
 * in `dedupeActive` (a fake returns whatever rows it holds, so it reads "already sent"
 * for a message it has never seen). A green test over a fake would prove neither.
 *
 * The classifier is an injected PORT with a literal result, not a mocked Claude: its
 * quality is the eval suite's and its own pipeline.test.ts's job (rule #8), and what is
 * under test here is what Hale DOES with a verdict.
 */

let db: TestDb;
let family: { familyId: string; parentUserId: string };

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

/** A fresh connection id per test: the dedupe key is (connection, message), and the
 * pglite instance is shared across the file, so a fixed one would make every test after
 * the first read as `already_sent`. */
let INTEGRATION: string;
const NOW = new Date('2026-09-17T15:00:00.000Z');
const PHONE = '+14165551234';
const CHILD_ID = '00000000-0000-4000-8000-0000000000c1';

const ENVELOPE = {
  subject: 'Swim class cancelled Saturday',
  from: 'Riverside Pool <info@riverside.example>',
  snippet: "Leo's Saturday swim class is cancelled this week",
  receivedAt: '2026-09-17T14:00:00.000Z',
};

function classified(
  over: Partial<ExtractedEvent> & {
    kind?: ExtractionKind;
    teenContent?: boolean;
    teenAttributed?: boolean;
  } = {},
): SentinelClassification {
  const { kind = 'cancellation', teenContent = false, teenAttributed = false, ...event } = over;
  return {
    status: 'classified',
    familyId: family.familyId,
    messageId: 'm1',
    extraction: {
      kind,
      event: {
        title: 'Saturday swim class cancelled',
        childRef: null,
        originalTime: '2026-09-19T13:00:00.000Z',
        newTime: null,
        location: null,
        ...event,
      },
      sourceConfidence: 0.9,
      quoteEvidence: 'the pool is closed this Saturday',
      teenContent,
      teenAttributed,
      matchedEventRef: null,
    },
    usage: { triage: { promptTokens: 1, completionTokens: 1 }, extract: null },
  };
}

const TRIAGED_OUT: SentinelClassification = {
  status: 'triaged_out',
  familyId: '',
  messageId: 'm1',
  extraction: null,
  usage: { triage: { promptTokens: 1, completionTokens: 1 }, extract: null },
};

interface Harness {
  ports: EmailAlertPorts;
  transport: FakeTransport;
  threaded: Array<{ familyId: string; parentUserId: string; body: string }>;
  classifyCalls: number;
  /** The writer port: what it was told, and what it answered. */
  writer: ScriptedNoticeWriter;
}

function harness(
  over: {
    classification?: SentinelClassification;
    classifyThrows?: boolean;
    verdict?: Awaited<ReturnType<EmailAlertPorts['gate']>>;
    phone?: string | null;
    sendThrows?: LinqSendError;
    notice?: EmailAlertNotice;
  } = {},
): Harness {
  const transport = new FakeTransport();
  const threaded: Harness['threaded'] = [];
  const writer = scriptedNoticeWriter({
    children: [{ id: CHILD_ID, name: 'Robin', ageInMonths: 40 }],
    ...(over.notice === undefined ? {} : { answer: over.notice }),
  });
  const h: Harness = {
    transport,
    threaded,
    classifyCalls: 0,
    writer,
    ports: {
      familyChildren: writer.familyChildren,
      writeNotice: writer.writeNotice,
      familyLanguage: writer.familyLanguage,
      classify: async () => {
        h.classifyCalls += 1;
        if (over.classifyThrows) throw new Error('gmail messages.get 503');
        return over.classification ?? classified();
      },
      gate: async () => over.verdict ?? { allowed: true, optOut: 'full' },
      resolvePhone: async () => (over.phone === undefined ? PHONE : over.phone),
      transport: over.sendThrows
        ? {
            async send() {
              throw over.sendThrows;
            },
          }
        : transport,
      threadMessage: async (_db, input) => {
        threaded.push(input);
        return 'conv-1';
      },
      timeZone: async () => 'America/Toronto',
    },
  };
  return h;
}

function alertPair(
  h: Harness,
  messageId = 'm1',
  over: Partial<Parameters<typeof alertParentForEmail>[1]> = {},
): Promise<EmailAlertResult> {
  return alertParentForEmail(
    db.database,
    {
      familyId: family.familyId,
      parentUserId: family.parentUserId,
      integrationId: INTEGRATION,
      messageId,
      envelope: ENVELOPE,
      cancelledThisSweep: new Set<string>(),
      timeZone: 'America/Toronto',
      now: NOW,
      ...over,
    },
    h.ports,
  );
}

/** The ALERT axis alone, which is what nearly every test in this file is about. The
 * BOOKING axis is a second, independent answer with its own describe and its own reads —
 * kept apart here so a change to one never silently rewrites the other's assertions. */
async function alert(h: Harness, messageId = 'm1'): Promise<EmailAlertOutcome> {
  return (await alertPair(h, messageId)).alert;
}

function ledgerRows() {
  return db.database
    .select()
    .from(schema.channelMessages)
    .where(eq(schema.channelMessages.familyId, family.familyId));
}

function auditRows() {
  return db.database
    .select()
    .from(schema.auditLog)
    .where(eq(schema.auditLog.familyId, family.familyId));
}

beforeEach(async () => {
  family = await seedFamily(db.database);
  INTEGRATION = randomUUID();
  vi.stubEnv('F14_ENABLED', 'true');
  vi.stubEnv('EMAIL_ALERT_ENABLED', 'true');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('alertParentForEmail', () => {
  it('sends exactly one text, ledgers it under the dedupe key, threads it and audits it', async () => {
    const h = harness();

    await expect(alert(h)).resolves.toBe('sent');

    expect(h.transport.sent).toHaveLength(1);
    const [rows, audit] = await Promise.all([ledgerRows(), auditRows()]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      category: 'email_alert',
      direction: 'out',
      channel: 'sms',
      templateKey: EMAIL_ALERT_TEMPLATE_KEY,
      dedupeKey: emailAlertDedupeKey(INTEGRATION, 'm1'),
      status: 'queued',
      providerMessageId: 'fake-out-1',
    });
    // Rule #1: the ledger never carries the sentence, let alone the email.
    expect(rows[0]?.body).toBeNull();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actionTaken: 'email_alert_sent',
      targetTable: 'channel_messages',
      targetId: rows[0]?.id,
      after: { kind: 'cancellation', teenContent: false },
    });
    // The composed sentence is the wire body. Neither carries an opt-out line.
    expect(h.threaded).toHaveLength(1);
    expect(h.threaded[0]?.body).not.toContain(OPT_OUT_LINE);
    expect(h.transport.sent[0]?.body).not.toContain(OPT_OUT_LINE);
    expect(h.transport.sent[0]?.body).not.toContain('STOP to opt out.');
    expect(h.transport.sent[0]?.body).toBe(h.threaded[0]?.body);
  });

  it('sends exactly the text the writer wrote — no code-built sentence around it', async () => {
    const h = harness({ notice: { send: true, text: 'Saturday swim is off this week.' } });
    await expect(alert(h)).resolves.toBe('sent');

    expect(h.writer.seen).toHaveLength(1);
    expect(h.transport.sent[0]?.body).toBe('Saturday swim is off this week.');
    expect(h.threaded[0]?.body).toBe('Saturday swim is off this week.');
  });

  it('hands the writer the EXTRACTION, never the snippet', async () => {
    // Rule #1: the body text of the email never reaches the writer, so it cannot be quoted
    // back. The positive control: the extraction's own title IS there.
    const h = harness();
    await expect(alert(h)).resolves.toBe('sent');

    const facts = h.writer.seen[0];
    expect(facts?.email.title).toBe('Saturday swim class cancelled');
    expect(facts?.email.sender).toBe('Riverside Pool');
    expect(JSON.stringify(facts)).not.toContain(ENVELOPE.snippet);
    expect(JSON.stringify(facts)).not.toContain('info@riverside.example');
  });

  it('texts a family that is not on the allowlist when F14_ENABLED is exactly true', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    vi.stubEnv('F14_FAMILY_ALLOWLIST', '00000000-0000-4000-8000-000000000000');
    const h = harness();

    await expect(alert(h)).resolves.toBe('sent');
    expect(h.transport.sent).toHaveLength(1);
  });

  it('is dark behind F14 — no classifier call, no text, nothing written', async () => {
    vi.stubEnv('F14_ENABLED', 'false');
    const h = harness();

    await expect(alert(h)).resolves.toBe('dark');

    expect(h.classifyCalls).toBe(0);
    expect(h.transport.sent).toEqual([]);
    await expect(ledgerRows()).resolves.toEqual([]);
  });

  it('a second sweep over the same message sends nothing and costs no classifier call', async () => {
    const first = harness();
    await expect(alert(first)).resolves.toBe('sent');

    const second = harness();
    await expect(alert(second)).resolves.toBe('already_sent');
    expect(second.classifyCalls).toBe(0);
    expect(second.transport.sent).toEqual([]);
    await expect(ledgerRows()).resolves.toHaveLength(1);
  });

  it('a DIFFERENT message in the same mailbox is still alerted', async () => {
    // Kills the mutation that drops the WHERE clause from the dedupe read (a fake DB
    // cannot fail this one — it returns whatever rows it holds).
    await expect(alert(harness())).resolves.toBe('sent');
    await expect(alert(harness(), 'm2')).resolves.toBe('sent');
    await expect(ledgerRows()).resolves.toHaveLength(2);
  });

  it('a newsletter is triaged out: no gate call, no ledger claim, and the key stays free', async () => {
    const h = harness({ classification: TRIAGED_OUT });

    await expect(alert(h)).resolves.toBe('not_parenting');

    expect(h.transport.sent).toEqual([]);
    await expect(ledgerRows()).resolves.toEqual([]);
    // Nothing was spent: if the same message is later re-read and IS parenting, it can
    // still be sent.
    await expect(alert(harness())).resolves.toBe('sent');
  });

  it('a gate hold leaves a RECEIPT on the ledger and does not consume the dedupe key', async () => {
    // A held email alert is never re-offered: the Gmail cursor advanced past this message
    // the moment the sweep read it, so "we'll catch it next time" is not true here the way
    // it is for a nudge. The row is therefore the only record that Hale read a parenting
    // email at 23:40 and chose to stay quiet — a console line is not a receipt (the
    // welcome card's shape, lib/channel/intake/welcome-card.ts).
    const held = harness({ verdict: { allowed: false, reason: 'quiet_hours' } });
    await expect(alert(held)).resolves.toBe('gate_refused:quiet_hours');
    expect(held.transport.sent).toEqual([]);

    const rows = await ledgerRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      category: 'email_alert',
      direction: 'out',
      templateKey: EMAIL_ALERT_TEMPLATE_KEY,
      status: 'suppressed_quiet_hours',
      // NEVER the key: the unique index is total over non-null keys, so a suppression
      // carrying it would block the very send it is a record of not making.
      dedupeKey: null,
      providerMessageId: null,
      body: null,
    });
    await expect(auditRows()).resolves.toEqual([]);

    const later = harness();
    await expect(alert(later)).resolves.toBe('sent');
    expect(later.transport.sent).toHaveLength(1);
  });

  it('names each gate hold separately and records it under its own suppression status', async () => {
    for (const reason of ['not_enrolled', 'no_watch_consent'] as const) {
      await expect(alert(harness({ verdict: { allowed: false, reason } }))).resolves.toBe(
        `gate_refused:${reason}`,
      );
    }
    const rows = await ledgerRows();
    expect(rows.map((r) => r.status).sort()).toEqual(['suppressed_consent', 'suppressed_consent']);
    expect(rows.map((r) => r.dedupeKey)).toEqual([null, null]);
  });

  it('a classifier that throws is a named outcome, never a throw into the sweep', async () => {
    // A throw from here is caught by syncConnection and marks the Gmail CONNECTION
    // errored — Hale blaming Google for its own outage.
    const h = harness({ classifyThrows: true });
    await expect(alert(h)).resolves.toBe('classifier_failed');
    await expect(ledgerRows()).resolves.toEqual([]);
  });

  it('a provider refusal fails the claimed row in place and keeps the key spent', async () => {
    const h = harness({ sendThrows: new LinqSendError('21610', 400, true) });
    await expect(alert(h)).resolves.toBe('send_failed');

    const rows = await ledgerRows();
    expect(rows[0]).toMatchObject({ status: 'failed', errorCode: '21610' });
    // At-most-once: a failed delivery must never un-consume idempotency.
    await expect(alert(harness())).resolves.toBe('already_sent');
    await expect(auditRows()).resolves.toEqual([]);
  });

  it('an allowed verdict with no sendable number is recorded, not thrown', async () => {
    const h = harness({ phone: null });
    await expect(alert(h)).resolves.toBe('no_send_target');
    const rows = await ledgerRows();
    expect(rows[0]).toMatchObject({ status: 'failed', errorCode: 'no_send_target' });
  });
});

describe('alertParentForGmailSweep', () => {
  function envelope(n: number, receivedAt?: string): GmailAlertEnvelope {
    return {
      messageId: `m${n}`,
      subject: ENVELOPE.subject,
      from: ENVELOPE.from,
      snippet: ENVELOPE.snippet,
      ...(receivedAt === undefined ? {} : { receivedAt }),
    };
  }

  function sweep(
    h: Harness,
    over: Partial<Parameters<typeof alertParentForGmailSweep>[1]> = {},
  ): Promise<readonly EmailAlertOutcome[]> {
    return sweepPairs(h, over).then((results) => results.map((r) => r.alert));
  }

  function sweepPairs(
    h: Harness,
    over: Partial<Parameters<typeof alertParentForGmailSweep>[1]> = {},
  ): Promise<readonly EmailAlertResult[]> {
    return alertParentForGmailSweep(
      db.database,
      {
        familyId: family.familyId,
        parentUserId: family.parentUserId,
        integrationId: INTEGRATION,
        seeding: false,
        envelopes: [],
        now: NOW,
        ...over,
      },
      h.ports,
    );
  }

  it('alerts NOTHING on the seeding run — 25 old emails are not 25 texts', async () => {
    const h = harness();
    const envelopes = [1, 2, 3].map((n) => envelope(n, `2026-09-1${n}T10:00:00.000Z`));

    await expect(sweep(h, { seeding: true, envelopes })).resolves.toEqual([
      'seeding_run',
      'seeding_run',
      'seeding_run',
    ]);
    expect(h.classifyCalls).toBe(0);
    expect(h.transport.sent).toEqual([]);
  });

  it('a mailbox with no connecting user has nobody to text, and says so', async () => {
    const h = harness();
    await expect(
      sweep(h, { parentUserId: null, envelopes: [envelope(1, '2026-09-17T10:00:00.000Z')] }),
    ).resolves.toEqual(['no_parent_user']);
    expect(h.classifyCalls).toBe(0);
  });

  it('reads every dated envelope, newest first, and drops none for a count', async () => {
    const h = harness();
    // 12 messages, m1 oldest .. m12 newest. All of them are told.
    const envelopes = Array.from({ length: 12 }, (_, i) =>
      envelope(i + 1, `2026-09-17T${String(i + 1).padStart(2, '0')}:00:00.000Z`),
    );

    const outcomes = await sweep(h, { envelopes });

    expect(outcomes.filter((o) => o === 'sent')).toHaveLength(12);
    expect(h.classifyCalls).toBe(12);
    const rows = await ledgerRows();
    const alerted = new Set(rows.map((r) => r.dedupeKey));
    expect(alerted.has(emailAlertDedupeKey(INTEGRATION, 'm12'))).toBe(true);
    expect(alerted.has(emailAlertDedupeKey(INTEGRATION, 'm1'))).toBe(true);
    expect(alerted.has(emailAlertDedupeKey(INTEGRATION, 'm2'))).toBe(true);
  });

  it('skips a message Gmail gave no internalDate for, and still reads the rest', async () => {
    const h = harness();
    const outcomes = await sweep(h, {
      envelopes: [envelope(1), envelope(2, '2026-09-17T10:00:00.000Z')],
    });
    expect(outcomes).toEqual(['no_received_at', 'sent']);
    expect(h.classifyCalls).toBe(1);
  });

  it('produces exactly one outcome per envelope, so the cron summary adds up', async () => {
    const h = harness();
    const envelopes = Array.from({ length: 12 }, (_, i) =>
      envelope(i + 1, `2026-09-17T${String(i + 1).padStart(2, '0')}:00:00.000Z`),
    );
    envelopes.push(envelope(13));
    await expect(sweep(h, { envelopes })).resolves.toHaveLength(13);
  });
});

describe('the email_alert lane', () => {
  const offerable = () =>
    classified({
      kind: 'new_event',
      title: 'Picture day',
      originalTime: null,
      newTime: '2026-10-02T13:00:00.000Z',
    });

  function offerRows() {
    return db.database
      .select()
      .from(schema.emailAlertOffers)
      .where(eq(schema.emailAlertOffers.familyId, family.familyId));
  }

  function sweepInput(
    over: Partial<Parameters<typeof alertParentForGmailSweep>[1]> = {},
  ): Parameters<typeof alertParentForGmailSweep>[1] {
    return {
      familyId: family.familyId,
      parentUserId: family.parentUserId,
      integrationId: INTEGRATION,
      seeding: false,
      envelopes: [
        { messageId: 'm1', ...ENVELOPE },
        { messageId: 'm2', subject: ENVELOPE.subject, from: ENVELOPE.from, snippet: '' },
      ],
      now: NOW,
      ...over,
    };
  }

  it('alertParentForEmail: lane off sends nothing, writes no row and names lane_off', async () => {
    vi.stubEnv('EMAIL_ALERT_ENABLED', undefined);
    const h = harness({ classification: offerable() });

    await expect(alertPair(h)).resolves.toEqual({ alert: 'lane_off', booking: null, going: null });

    expect(h.classifyCalls).toBe(0);
    expect(h.transport.sent).toEqual([]);
    expect(h.threaded).toEqual([]);
    await expect(ledgerRows()).resolves.toEqual([]);
    await expect(offerRows()).resolves.toEqual([]);
    await expect(auditRows()).resolves.toEqual([]);
  });

  it('alertParentForEmail: lane exactly true sends the text and writes its offer', async () => {
    vi.stubEnv('EMAIL_ALERT_ENABLED', 'true');
    const h = harness({ classification: offerable() });

    await expect(alert(h)).resolves.toBe('sent');

    expect(h.transport.sent).toHaveLength(1);
    await expect(offerRows()).resolves.toHaveLength(1);
  });

  it('alertParentForGmailSweep: lane off names EVERY envelope lane_off before reading the clock', async () => {
    vi.stubEnv('EMAIL_ALERT_ENABLED', 'false');
    const h = harness({ classification: offerable() });
    const timeZone = vi.spyOn(h.ports, 'timeZone');
    vi.spyOn(console, 'info').mockImplementation(() => {});

    const outcomes = await alertParentForGmailSweep(db.database, sweepInput(), h.ports);

    expect(outcomes).toEqual([
      { alert: 'lane_off', booking: null, going: null },
      { alert: 'lane_off', booking: null, going: null },
    ]);
    expect(timeZone).not.toHaveBeenCalled();
    expect(h.classifyCalls).toBe(0);
    expect(h.transport.sent).toEqual([]);
    await expect(ledgerRows()).resolves.toEqual([]);
    await expect(offerRows()).resolves.toEqual([]);
  });

  it('alertParentForGmailSweep: the backfill pass is held by its caller (backfillBookedMail), not per envelope here', async () => {
    vi.stubEnv('EMAIL_ALERT_ENABLED', undefined);
    vi.stubEnv('BOOKED_DETECTION_ENABLED', 'false');
    const h = harness({ classification: offerable() });
    vi.spyOn(console, 'info').mockImplementation(() => {});

    const outcomes = await alertParentForGmailSweep(
      db.database,
      sweepInput({ backfill: true, envelopes: [{ messageId: 'm1', ...ENVELOPE }] }),
      h.ports,
    );

    expect(outcomes).toEqual([
      { alert: 'backfill_suppressed', booking: 'booked_dark', going: null },
    ]);
    expect(h.transport.sent).toEqual([]);
  });

  it('alertParentForGmailSweep: lane exactly true reaches the send', async () => {
    vi.stubEnv('EMAIL_ALERT_ENABLED', 'true');
    const h = harness({ classification: offerable() });
    vi.spyOn(console, 'info').mockImplementation(() => {});

    const outcomes = await alertParentForGmailSweep(db.database, sweepInput(), h.ports);

    expect(outcomes.map((o) => o.alert)).toEqual(['no_received_at', 'sent']);
    expect(h.transport.sent).toHaveLength(1);
  });
});

describe('the offer at the end', () => {
  /**
   * The question Hale may end on, and the row that has to exist before it may ask it.
   *
   * #649 removed "I can add it to your week - reply YES" because nothing consumed the YES:
   * a parent doing what the text said reached the coach with nothing drafted, or, with one
   * unrelated action pending, approved THAT one. The writer is told whether there is an
   * offer, and its refusals hold its question to that (email-alert-notice.test.ts). So the
   * two halves are asserted together here: the `offer` fact the writer was handed, and the
   * row. One without the other is the bug coming back.
   */
  const future = (
    over: Partial<ExtractedEvent> & { kind?: ExtractionKind; teenContent?: boolean } = {},
  ) =>
    classified({
      kind: 'new_event',
      title: 'Picture day',
      originalTime: null,
      newTime: '2026-10-02T13:00:00.000Z',
      ...over,
    });

  function offerRows() {
    return db.database
      .select()
      .from(schema.emailAlertOffers)
      .where(eq(schema.emailAlertOffers.familyId, family.familyId));
  }

  it('writes ONE offer row against the text the writer was told could ask', async () => {
    const h = harness({ classification: future({ location: 'the gym' }) });

    await expect(alert(h)).resolves.toBe('sent');

    expect(h.writer.seen[0]?.offer).toBe('add_to_week');
    expect(h.transport.sent[0]?.body).toContain('?');
    const [rows, offers] = await Promise.all([ledgerRows(), offerRows()]);
    const sent = rows.find((row) => row.dedupeKey !== null);
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({
      parentUserId: family.parentUserId,
      integrationId: INTEGRATION,
      messageId: 'm1',
      kind: 'new_event',
      title: 'Picture day',
      location: 'the gym',
      // Against the row that carried it: an offer nobody was told about is not an offer.
      channelMessageId: sent?.id,
      resolvedAt: null,
      resolution: null,
      eventId: null,
    });
    const offer = offers[0];
    if (!offer) throw new Error('no offer row');
    expect(offer.startsAt.toISOString()).toBe('2026-10-02T13:00:00.000Z');
    // 24h from the send, applied at the reader rather than by a sweep.
    expect(offer.expiresAt.getTime() - NOW.getTime()).toBe(EMAIL_ALERT_OFFER_TTL_MS);
  });

  it('holds the offer fact and the row to the same decision, shape by shape', async () => {
    // Each of these is a way the question would be untrue. No row means the writer was
    // told there is no offer, in one table so a future shape cannot get one without the other.
    const silent: Array<[string, SentinelClassification]> = [
      // A cancellation is the REMOVAL of a date; putting it on the week is the opposite.
      ['a cancellation', classified()],
      // Nothing to put anywhere.
      ['no usable time', future({ newTime: null })],
      ['a time the model did not write as a date', future({ newTime: 'next Friday' })],
      // An offer to put last Tuesday on your week is a sentence nobody would write.
      ['a date already past', future({ newTime: '2026-09-01T13:00:00.000Z' })],
      // The pipeline genericized the title, so there is no occasion left to add — and
      // adding one would re-disclose what the teen gate just removed (rule #1).
      ['a 13+ child', future({ teenContent: true })],
      // A title that survives sanitising as nothing at all.
      ['a title outside the alphabet', future({ title: '。。。' })],
    ];

    for (const [why, classification] of silent) {
      family = await seedFamily(db.database);
      INTEGRATION = randomUUID();
      const h = harness({ classification });

      await expect(alert(h), why).resolves.toBe('sent');

      expect(h.writer.seen[0]?.offer, why).toBeNull();
      expect(h.transport.sent[0]?.body, why).not.toContain('?');
      await expect(offerRows(), why).resolves.toHaveLength(0);
    }
  });

  it('tells the writer a Google Calendar event is the parent’s own, and offers nothing', async () => {
    // The event is already on the parent's calendar; asking to add it is asking twice.
    const from = 'Google Calendar <calendar-notification@google.com>';
    const event = {
      title: 'Gymnastics',
      childRef: null,
      originalTime: '2026-10-01T20:15:00.000Z',
      newTime: null,
      location: 'the gym',
    };
    expect(
      emailAlertOfferDraft({
        kind: 'reminder_only',
        event,
        teenContent: false,
        matchedEventRef: null,
        booked: false,
        from,
        now: NOW,
      }),
    ).toBeNull();

    const h = harness({ classification: classified({ kind: 'reminder_only', ...event }) });
    await expect(
      alertPair(h, 'm-cal', {
        envelope: {
          subject: 'Notification: Gymnastics',
          from,
          snippet: 'Gymnastics tomorrow',
          receivedAt: '2026-09-17T14:00:00.000Z',
        },
      }),
    ).resolves.toMatchObject({ alert: 'sent' });
    expect(h.writer.seen[0]).toMatchObject({ fromParentsOwnCalendar: true, offer: null });
    await expect(offerRows()).resolves.toHaveLength(0);
  });
});

/**
 * THE TWO TEXTS THAT REACHED A PARENT, recreated with fake names. Both came from code that
 * built "<sender> sent something about <title>" for an extraction that could not say what
 * the email was. There is no such sentence any more: an `unclear` reading is nothing sent,
 * decided before the writer is paid for, and the writer's own "not about the kids" or
 * "unclear" is nothing sent too.
 */
describe('nothing is sent unless the writer says it is about the kids', () => {
  const HOLADE = {
    subject: 'Your weekly update',
    from: 'Holade <hello@holade.example>',
    snippet: 'This week at Holade',
    receivedAt: '2026-09-17T14:00:00.000Z',
  };
  const SELF_MAIL = {
    subject: 'Regular hour program',
    from: 'Avery Lin <avery.lin@mail.example>',
    snippet: 'Notes on the regular hour program',
    receivedAt: '2026-09-17T14:00:00.000Z',
  };

  async function nothingWritten(h: Harness) {
    expect(h.transport.sent).toEqual([]);
    expect(h.threaded).toEqual([]);
    await expect(ledgerRows()).resolves.toEqual([]);
    await expect(auditRows()).resolves.toEqual([]);
  }

  it('PROD CASE 1: "<vendor> sent something about Unknown" — an unclear reading is silent', async () => {
    const h = harness({ classification: classified({ kind: 'unclear', title: 'Unknown' }) });
    await expect(alertPair(h, 'm1', { envelope: HOLADE })).resolves.toEqual({
      alert: 'unclear',
      booking: null,
      going: null,
    });
    expect(h.writer.seen).toEqual([]);
    await nothingWritten(h);
  });

  it('PROD CASE 2: the parent’s own mail about "Regular hour program" is silent', async () => {
    const h = harness({
      classification: classified({ kind: 'unclear', title: 'Regular hour program' }),
    });
    await expect(alertPair(h, 'm1', { envelope: SELF_MAIL })).resolves.toMatchObject({
      alert: 'unclear',
    });
    expect(h.writer.seen).toEqual([]);
    await nothingWritten(h);
    // The same email read as a kind the writer does decide: its "no" is nothing sent.
    family = await seedFamily(db.database);
    const writerSaysNo = harness({
      classification: classified({ kind: 'new_event', title: 'Regular hour program' }),
      notice: { send: false, why: 'not_about_the_kids' },
    });
    await expect(alertPair(writerSaysNo, 'm1', { envelope: SELF_MAIL })).resolves.toEqual({
      alert: 'not_about_the_kids',
      booking: null,
      going: null,
    });
    expect(writerSaysNo.writer.seen[0]?.email).toMatchObject({
      sender: 'Avery Lin',
      subject: 'Regular hour program',
      title: 'Regular hour program',
    });
    expect(writerSaysNo.writer.seen[0]?.children).toEqual([{ name: 'Robin', ageYears: 3 }]);
    await nothingWritten(writerSaysNo);
  });

  it('names every writer refusal as its own outcome, and writes nothing — not even a hold', async () => {
    const cases: Array<[Extract<EmailAlertNotice, { send: false }>['why'], EmailAlertOutcome]> = [
      ['not_about_the_kids', 'not_about_the_kids'],
      ['unclear', 'unclear'],
      ['unwritten', 'notice_unwritten'],
    ];
    for (const [why, outcome] of cases) {
      family = await seedFamily(db.database);
      INTEGRATION = randomUUID();
      // A gate that would hold proves the writer runs first: no suppression receipt.
      const h = harness({
        notice: { send: false, why },
        verdict: { allowed: false, reason: 'quiet_hours' },
      });
      await expect(alert(h), why).resolves.toBe(outcome);
      expect(h.writer.seen, why).toHaveLength(1);
      await nothingWritten(h);
    }
  });

  it('a writer failure leaves the dedupe key unspent', async () => {
    await expect(alert(harness({ notice: { send: false, why: 'unwritten' } }))).resolves.toBe(
      'notice_unwritten',
    );
    await expect(alert(harness())).resolves.toBe('sent');
  });

  it('a 13+ child’s mail reaches the writer category-only (rule #1)', async () => {
    const h = harness({
      classification: classified({
        kind: 'new_event',
        title: 'a message about school',
        childRef: CHILD_ID,
        newTime: '2026-10-02T13:00:00.000Z',
        location: 'Room 4',
        teenContent: true,
      }),
    });
    await expect(alert(h)).resolves.toBe('sent');
    expect(h.writer.seen[0]?.children).toEqual([]);
    expect(h.writer.seen[0]).toMatchObject({
      private: true,
      offer: null,
      otherHaleFamiliesGoing: null,
      email: {
        sender: null,
        subject: null,
        namedChild: null,
        was: null,
        when: null,
        location: null,
        title: 'a message about school',
      },
    });
  });
});

/**
 * ALREADY ON THE CALENDAR (main 08c24b497, email-alert.ts:1252): a matched event dropped
 * only the offer and still texted, which sent a second Storytime text at 13:00 for an
 * event the family already held. Matched and unchanged is nothing sent; a cancellation or
 * a move of that event is the news, and still sends.
 */
describe('an email about an event already on the calendar', () => {
  function matched(kind: ExtractionKind, over: Partial<ExtractedEvent> = {}) {
    const c = classified({
      kind,
      title: 'Storytime',
      originalTime: '2026-09-19T17:00:00.000Z',
      newTime: null,
      ...over,
    });
    if (!c.extraction) throw new Error('fixture lost its extraction');
    c.extraction.matchedEventRef = { table: 'family_events', id: randomUUID() };
    return c;
  }

  for (const kind of ['reminder_only', 'new_event', 'booking_confirmation'] as const) {
    it(`MATCHED, UNCHANGED (${kind}): nothing sent, and the writer is never asked`, async () => {
      const h = harness({ classification: matched(kind) });
      const result = await alertPair(h);
      expect(result.alert).toBe('already_on_calendar');
      expect(result.going).toBeNull();
      expect(h.writer.seen).toEqual([]);
      expect(h.transport.sent).toEqual([]);
      expect(h.threaded).toEqual([]);
      await expect(ledgerRows()).resolves.toEqual([]);
      await expect(
        db.database
          .select()
          .from(schema.emailAlertOffers)
          .where(eq(schema.emailAlertOffers.familyId, family.familyId)),
      ).resolves.toEqual([]);
    });
  }

  it('MATCHED, CANCELLED: sends, and the writer knows it is on the calendar', async () => {
    const h = harness({ classification: matched('cancellation') });
    await expect(alert(h)).resolves.toBe('sent');
    expect(h.transport.sent).toHaveLength(1);
    expect(h.writer.seen[0]).toMatchObject({
      alreadyOnCalendar: true,
      offer: null,
      email: { kind: 'cancellation', title: 'Storytime' },
    });
  });

  it('MATCHED, RESCHEDULED: sends with both times, and offers nothing', async () => {
    const h = harness({
      classification: matched('reschedule', { newTime: '2026-09-20T17:00:00.000Z' }),
    });
    await expect(alert(h)).resolves.toBe('sent');
    expect(h.transport.sent).toHaveLength(1);
    expect(h.writer.seen[0]).toMatchObject({
      alreadyOnCalendar: true,
      offer: null,
      email: {
        kind: 'reschedule',
        was: { date: 'Saturday, September 19, 2026', time: '1:00 PM' },
        when: { date: 'Sunday, September 20, 2026', time: '1:00 PM' },
      },
    });
  });

  it('the same Storytime, unmatched, is still told — the match is what makes it a duplicate', async () => {
    const h = harness({
      classification: classified({
        kind: 'reminder_only',
        title: 'Storytime',
        originalTime: '2026-09-19T17:00:00.000Z',
      }),
    });
    await expect(alert(h)).resolves.toBe('sent');
    expect(h.writer.seen[0]?.alreadyOnCalendar).toBe(false);
  });
});

describe('the gate registration', () => {
  it('files email alerts on their own ledger category', () => {
    expect(PROACTIVE_CATEGORY.email_alert).toBe('email_alert');
  });
});

/**
 * ...and the same feature through the REAL alert path, where the question is not what the
 * words are but whether the query runs at all.
 */
describe('the going count in the alert path', () => {
  const RECEIPT = {
    subject: 'Registration Confirmation - Swim Level 2',
    from: 'Brookfield Recreation <noreply@recreation.brookfield.example.ca>',
    snippet: "You're registered for Swim Level 2.",
    receivedAt: '2026-09-17T14:00:00.000Z',
  };
  const FIRST_SESSION = '2026-09-26T13:00:00.000Z';
  /** The fragment only the going count's own SELECT carries — how "the query was never
   * issued" is observed rather than inferred from an answer that would look the same
   * either way. */
  const COUNT_QUERY = '"activity_bookings"."session_key" =';

  function receipt(): SentinelClassification {
    return classified({
      kind: 'booking_confirmation',
      title: 'Swim Level 2',
      originalTime: null,
      newTime: FIRST_SESSION,
      location: 'the Leisure Centre',
    });
  }

  /** Another household already holding this session — a ROW, because their booking is data
   * rather than behaviour under test. The key is computed by the SHIPPED function, so a
   * change to the fold moves the fixture with it. */
  async function otherFamilyBooked(name: string): Promise<string> {
    const other = await seedFamily(db.database, name);
    counted.push(other.familyId);
    const [message] = await db.database
      .insert(schema.channelMessages)
      .values({
        familyId: other.familyId,
        parentUserId: other.parentUserId,
        channel: 'sms',
        direction: 'out',
        category: 'email_alert',
        status: 'sent',
      })
      .returning({ id: schema.channelMessages.id });
    await db.database.insert(schema.activityBookings).values({
      familyId: other.familyId,
      parentUserId: other.parentUserId,
      integrationId: randomUUID(),
      messageId: randomUUID(),
      providerHost: 'recreation.brookfield.example.ca',
      title: 'Swim Level 2',
      firstSessionAt: new Date(FIRST_SESSION),
      sessionKey: sessionKey({
        providerHost: 'recreation.brookfield.example.ca',
        title: 'Swim Level 2',
        titleIsFallback: false,
        firstSessionAt: new Date(FIRST_SESSION),
      }),
      channelMessageId: message?.id as string,
    });
    return other.familyId;
  }

  /** Every statement the driver actually ran this call. The observation point the pglite
   * harness documents for exactly this: an invariant the caller's ANSWER cannot show. */
  async function statementsDuring<T>(run: () => Promise<T>): Promise<{ sql: string[]; out: T }> {
    const sql: string[] = [];
    const query = db.client.query.bind(db.client);
    const exec = db.client.exec.bind(db.client);
    db.client.query = ((text: string, ...rest: unknown[]) => {
      sql.push(String(text));
      return (query as (...a: unknown[]) => unknown)(text, ...rest);
    }) as typeof db.client.query;
    db.client.exec = ((text: string, ...rest: unknown[]) => {
      sql.push(String(text));
      return (exec as (...a: unknown[]) => unknown)(text, ...rest);
    }) as typeof db.client.exec;
    try {
      return { sql, out: await run() };
    } finally {
      db.client.query = query;
      db.client.exec = exec;
    }
  }

  /** The households seeded as already holding the session, this test only. */
  let counted: string[] = [];

  beforeEach(async () => {
    vi.stubEnv('BOOKED_DETECTION_ENABLED', 'true');
    counted = [];
    // The pglite instance is shared across this file and the count reads ACROSS families,
    // so an earlier describe's bookings would be counted into this one's sentence.
    await db.database.delete(schema.activityBookings);
  });

  it('speaks the count, audits the NUMBER and nothing else, and writes no row on the other side', async () => {
    vi.stubEnv(GOING_COUNT_ENABLED_ENV, 'true');
    await otherFamilyBooked('Other A');
    await otherFamilyBooked('Other B');
    const h = harness({ classification: receipt() });

    await expect(alertPair(h, 'm1', { envelope: RECEIPT })).resolves.toEqual({
      alert: 'sent',
      booking: 'recorded',
      going: 'shown',
    });
    expect(h.writer.seen[0]?.otherHaleFamiliesGoing).toBe(2);
    expect(h.writer.seen[0]?.offer).toBe('add_to_calendar');

    const sent = (await auditRows()).find((row) => row.actionTaken === 'email_alert_sent');
    // `toEqual` rather than `toMatchObject`: the rule for this row is enums and flags only,
    // and a subset match would pass with the provider's domain sitting beside the number.
    expect(sent?.after).toEqual({
      kind: 'booking_confirmation',
      teenContent: false,
      othersCount: 2,
    });
    const trail = JSON.stringify(sent?.after);
    for (const leak of ['brookfield', 'Swim Level 2', FIRST_SESSION]) {
      expect(trail).not.toContain(leak);
    }

    // THE FOURTH-AXIS ASSERTION: the counted households get NO audit row and NO message. A
    // row in their trail saying their booking was counted would tell them another Hale
    // family is in their child's class — the same disclosure, in reverse, unasked. This is
    // the one that would catch anybody "improving" the design by auditing the subjects.
    expect(counted).toHaveLength(2);
    for (const id of counted) {
      await expect(
        db.database.select().from(schema.auditLog).where(eq(schema.auditLog.familyId, id)),
      ).resolves.toEqual([]);
      // Exactly the one row this fixture wrote to hang their booking off, and nothing Hale
      // sent: no second text, no suppression receipt, no thread.
      await expect(
        db.database
          .select()
          .from(schema.channelMessages)
          .where(eq(schema.channelMessages.familyId, id)),
      ).resolves.toHaveLength(1);
    }
  });

  it('says nothing, and audits null, when only one other family holds the session', async () => {
    vi.stubEnv(GOING_COUNT_ENABLED_ENV, 'true');
    await otherFamilyBooked('Other A');
    const h = harness({ classification: receipt() });

    await expect(alertPair(h, 'm1', { envelope: RECEIPT })).resolves.toMatchObject({
      going: 'below_floor',
    });
    expect(h.writer.seen[0]?.otherHaleFamiliesGoing).toBeNull();
    const sent = (await auditRows()).find((row) => row.actionTaken === 'email_alert_sent');
    expect(sent?.after).toEqual({
      kind: 'booking_confirmation',
      teenContent: false,
      othersCount: null,
    });
  });

  it('never speaks twice about one session — the second receipt is a repeat', async () => {
    vi.stubEnv(GOING_COUNT_ENABLED_ENV, 'true');
    await otherFamilyBooked('Other A');
    await otherFamilyBooked('Other B');
    const first = harness({ classification: receipt() });
    await expect(alertPair(first, 'm1', { envelope: RECEIPT })).resolves.toMatchObject({
      going: 'shown',
    });

    // A provider that sends "Registration confirmed" and then "Payment receipt" is two
    // receipts for one session. Reading 2 at 09:00 and 3 at 14:00 would tell this family
    // that exactly one household registered in between.
    const second = harness({ classification: receipt() });
    await expect(alertPair(second, 'm2', { envelope: RECEIPT })).resolves.toMatchObject({
      going: 'repeat_receipt',
    });
    expect(second.writer.seen[0]?.otherHaleFamiliesGoing).toBeNull();
  });

  it('a receipt later the same day refreshes the row and does not raise the count', async () => {
    vi.stubEnv(GOING_COUNT_ENABLED_ENV, 'true');
    await otherFamilyBooked('Other A');
    await otherFamilyBooked('Other B');
    const first = harness({ classification: receipt() });
    await expect(alertPair(first, 'm1', { envelope: RECEIPT })).resolves.toMatchObject({
      booking: 'recorded',
      going: 'shown',
    });
    expect(first.writer.seen[0]?.otherHaleFamiliesGoing).toBe(2);

    // The invoice said 1:00; the receipt says 1:30 and spells the title differently.
    // Same class, same UTC day. A second row would be a second follow-up, and a
    // second session key would let the next family read 3.
    const second = harness({
      classification: classified({
        kind: 'booking_confirmation',
        title: 'swim LEVEL 2',
        originalTime: null,
        newTime: '2026-09-26T13:30:00.000Z',
        location: 'the Leisure Centre',
      }),
    });
    await expect(
      alertPair(second, 'm2', {
        envelope: {
          ...RECEIPT,
          subject: 'Payment receipt — Swim Level 2',
          snippet: 'Receipt for Swim Level 2. You are registered.',
        },
      }),
    ).resolves.toMatchObject({ booking: 'refreshed', going: 'repeat_receipt' });
    expect(second.writer.seen[0]?.otherHaleFamiliesGoing).toBeNull();

    const rows = await db.database
      .select()
      .from(schema.activityBookings)
      .where(eq(schema.activityBookings.familyId, family.familyId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.messageId).toBe('m1');
    expect(
      (await auditRows()).filter((row) => row.actionTaken === 'activity_booking_recorded'),
    ).toHaveLength(1);
  });

  it('DARK: the query is not issued at all, and the writer is handed no count', async () => {
    await otherFamilyBooked('Other A');
    await otherFamilyBooked('Other B');
    const lit = harness({ classification: receipt() });
    vi.stubEnv(GOING_COUNT_ENABLED_ENV, 'true');
    await alertPair(lit, 'm1', { envelope: RECEIPT });
    expect(lit.writer.seen[0]?.otherHaleFamiliesGoing).toBe(2);

    // ...and now with the flag in its `vercel env add` failure shape.
    vi.stubEnv(GOING_COUNT_ENABLED_ENV, 'true\n');
    const dark = harness({ classification: receipt() });
    const { sql, out } = await statementsDuring(() => alertPair(dark, 'm2', { envelope: RECEIPT }));
    expect(out.going).toBe('going_dark');
    expect(sql.some((text) => text.includes(COUNT_QUERY))).toBe(false);
    expect(dark.writer.seen[0]?.otherHaleFamiliesGoing).toBeNull();
    // The positive control for the observation itself: a LIT run of a class this
    // family does not already hold does issue the count query. A second receipt of
    // the class above returns before that query — it is already a repeat.
    const litAgain = harness({
      classification: classified({
        kind: 'booking_confirmation',
        title: 'Skating Level 1',
        originalTime: null,
        newTime: FIRST_SESSION,
        location: 'the Leisure Centre',
      }),
    });
    vi.stubEnv(GOING_COUNT_ENABLED_ENV, 'true');
    const observed = await statementsDuring(() => alertPair(litAgain, 'm3', { envelope: RECEIPT }));
    expect(observed.sql.some((text) => text.includes(COUNT_QUERY))).toBe(true);
  });

  it('DARK-BOOKED: a family whose bookings are not recorded reads nobody else’s', async () => {
    // Two flags, two questions, and the count is downstream of both: dark-booked there is
    // no booking frame to carry a clause, so reading other households' rows for it would
    // be a disclosure query run for a sentence that cannot exist.
    vi.stubEnv(GOING_COUNT_ENABLED_ENV, 'true');
    vi.stubEnv('BOOKED_DETECTION_ENABLED', 'false');
    await otherFamilyBooked('Other A');
    await otherFamilyBooked('Other B');
    const h = harness({ classification: receipt() });
    const { sql, out } = await statementsDuring(() => alertPair(h, 'm1', { envelope: RECEIPT }));
    expect(out).toEqual({ alert: 'sent', booking: 'booked_dark', going: null });
    expect(sql.some((text) => text.includes(COUNT_QUERY))).toBe(false);
  });

  it('withholds the count for a 13+ child, and says which gate did it', async () => {
    vi.stubEnv(GOING_COUNT_ENABLED_ENV, 'true');
    await otherFamilyBooked('Other A');
    await otherFamilyBooked('Other B');
    const h = harness({
      classification: classified({
        kind: 'booking_confirmation',
        title: 'Swim Level 2',
        originalTime: null,
        newTime: FIRST_SESSION,
        location: null,
        teenAttributed: true,
      }),
    });
    // No booking, therefore no count — and the going axis keeps the teen reason rather than
    // folding it into "never reached the decision", because that rate is rule #1's.
    await expect(alertPair(h, 'm1', { envelope: RECEIPT })).resolves.toEqual({
      alert: 'sent',
      booking: 'teen_attributed',
      going: 'teen_attributed',
    });
    expect(h.writer.seen[0]?.otherHaleFamiliesGoing).toBeNull();
  });

  it('ERASURE: deleting one counted family drops the count the writer is handed', async () => {
    vi.stubEnv(GOING_COUNT_ENABLED_ENV, 'true');
    const erasedId = await otherFamilyBooked('Other A');
    await otherFamilyBooked('Other B');
    // THE POSITIVE CONTROL FIRST, on a household of its own: without it the assertion below
    // passes on a count that was never 2. Note that this leg WRITES a third booking, which
    // is why both it and Other A are erased next - the claim is about the cascade, and a
    // count that fell because one household was never in it would prove nothing.
    const control = await sweepDetail('Third', 'm1');
    expect(control.result.going).toBe('shown');
    expect(control.othersGoing).toBe(2);

    // The cascade IS the erasure path - `runDeletionSweep` issues one DELETE FROM families
    // and lets it take the bookings - so it is asserted rather than trusted, and the count
    // is a query rather than an aggregate precisely so nothing has to recompute.
    await db.database
      .delete(schema.families)
      .where(inArray(schema.families.id, [erasedId, control.familyId]));

    const { result, othersGoing } = await sweepDetail('Fifth', 'm2');
    expect(result.going).toBe('below_floor');
    expect(othersGoing).toBeNull();
  });

  /** One fresh household receiving this same receipt - the shape both erasure legs need. */
  async function sweepDetail(
    name: string,
    messageId: string,
  ): Promise<{ familyId: string; result: EmailAlertResult; othersGoing: number | null }> {
    const household = await seedFamily(db.database, name);
    const h = harness({ classification: receipt() });
    const result = await alertParentForEmail(
      db.database,
      {
        familyId: household.familyId,
        parentUserId: household.parentUserId,
        integrationId: randomUUID(),
        messageId,
        envelope: RECEIPT,
        cancelledThisSweep: new Set<string>(),
        timeZone: 'America/Toronto',
        now: NOW,
      },
      h.ports,
    );
    return {
      familyId: household.familyId,
      result,
      othersGoing: h.writer.seen[0]?.otherHaleFamiliesGoing ?? null,
    };
  }
});
