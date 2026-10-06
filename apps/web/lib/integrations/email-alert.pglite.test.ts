import { randomUUID } from 'node:crypto';
import { schema } from '@hale/db';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeTransport } from '~/lib/channel/intake/transport';
import { LinqSendError } from '~/lib/channel/linq/transport';
import { OPT_OUT_LINE } from '~/lib/channel/opt-out';
import { PROACTIVE_CAP, PROACTIVE_CATEGORY } from '~/lib/channel/outbound-gate';
import { extractStateClaims } from '~/lib/channel/reconcile/claims';
import { isPrintableGsm7Basic, smsEncoding, smsSegments } from '~/lib/channel/sms-segments';
import type { ExtractedEvent, ExtractionKind, SentinelClassification } from '~/lib/sentinel';
import { type TestDb, createTestDb, seedFamily, seedIntegration } from '~/lib/testing/pglite';
import {
  EMAIL_ALERT_MAX_PER_SWEEP,
  EMAIL_ALERT_TEMPLATE_KEY,
  type EmailAlertOutcome,
  type EmailAlertPorts,
  type EmailAlertRenderInput,
  type EmailAlertResult,
  type GmailAlertEnvelope,
  alertParentForEmail,
  alertParentForGmailSweep,
  emailAlertDedupeKey,
  emailAlertOfferDraft,
  emailAlertVoiceFacts,
} from './email-alert';
import { EMAIL_ALERT_OFFER_TTL_MS } from './email-alert-offer';
import {
  type EmailAlertVoiceFacts,
  type EmailAlertVoicePorts,
  echoEmailAlertLine,
  emailAlertAccepts,
  writeEmailAlert,
} from './email-alert-voice';
import { GOING_COUNT_ENABLED_ENV, type GoingCount, sessionKey } from './going';

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
}

function echoVoice(pages: string[] = []): EmailAlertVoicePorts {
  return {
    attempt: async (facts) => echoEmailAlertLine(facts),
    alert: async (text) => {
      pages.push(text);
    },
  };
}

function harness(
  over: {
    classification?: SentinelClassification;
    classifyThrows?: boolean;
    verdict?: Awaited<ReturnType<EmailAlertPorts['gate']>>;
    phone?: string | null;
    sendThrows?: LinqSendError;
    voice?: EmailAlertVoicePorts;
  } = {},
): Harness {
  const transport = new FakeTransport();
  const threaded: Harness['threaded'] = [];
  const h: Harness = {
    transport,
    threaded,
    classifyCalls: 0,
    ports: {
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
      voice: over.voice ?? echoVoice(),
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

  it('carries the EXTRACTION and no line of the email — not the snippet, not the subject', async () => {
    // Rule #1, as the only assertion that can fail when the email itself starts riding
    // along. The positive control is the pair: the extraction's own title MUST be there,
    // so the two `not.toContain`s cannot pass on an empty or truncated body.
    const h = harness();
    await expect(alert(h)).resolves.toBe('sent');

    for (const body of [h.transport.sent[0]?.body, h.threaded[0]?.body]) {
      expect(body).toContain('Saturday swim class');
      expect(body).not.toContain(ENVELOPE.snippet);
      expect(body).not.toContain(ENVELOPE.subject);
      expect(body).not.toContain('Leo');
    }
  });

  it('sends nothing and spends no dedupe key when the line is refused twice', async () => {
    const pages: string[] = [];
    const h = harness({
      voice: {
        attempt: async () => 'Thursday, Oct 1 at 4:15 p.m.',
        alert: async (text) => {
          pages.push(text);
        },
      },
    });

    await expect(alert(h)).resolves.toBe('voice_unsent');
    expect(h.transport.sent).toHaveLength(0);
    expect(pages).toEqual(['email alert: unsent after retry (cancellation, title)']);
    expect(pages[0]).not.toContain('Saturday swim class');
    await expect(ledgerRows()).resolves.toHaveLength(0);
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
    for (const reason of ['not_enrolled', 'no_watch_consent', 'frequency_cap'] as const) {
      await expect(alert(harness({ verdict: { allowed: false, reason } }))).resolves.toBe(
        `gate_refused:${reason}`,
      );
    }
    const rows = await ledgerRows();
    expect(rows.map((r) => r.status).sort()).toEqual([
      'suppressed_cap',
      'suppressed_consent',
      'suppressed_consent',
    ]);
    expect(rows.map((r) => r.dedupeKey)).toEqual([null, null, null]);
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

  it('reads at most EMAIL_ALERT_MAX_PER_SWEEP, NEWEST first, and names the rest', async () => {
    const h = harness();
    // 12 messages, m1 oldest .. m12 newest. The cap must drop the two OLDEST.
    const envelopes = Array.from({ length: 12 }, (_, i) =>
      envelope(i + 1, `2026-09-17T${String(i + 1).padStart(2, '0')}:00:00.000Z`),
    );

    const outcomes = await sweep(h, { envelopes });

    expect(outcomes.filter((o) => o === 'over_sweep_cap')).toHaveLength(2);
    expect(outcomes.filter((o) => o === 'sent')).toHaveLength(EMAIL_ALERT_MAX_PER_SWEEP);
    expect(h.classifyCalls).toBe(EMAIL_ALERT_MAX_PER_SWEEP);
    const rows = await ledgerRows();
    const alerted = new Set(rows.map((r) => r.dedupeKey));
    expect(alerted.has(emailAlertDedupeKey(INTEGRATION, 'm12'))).toBe(true);
    expect(alerted.has(emailAlertDedupeKey(INTEGRATION, 'm1'))).toBe(false);
    expect(alerted.has(emailAlertDedupeKey(INTEGRATION, 'm2'))).toBe(false);
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

const factsOf = (input: EmailAlertRenderInput): EmailAlertVoiceFacts =>
  emailAlertVoiceFacts(input).facts;

describe('the facts the voice is given', () => {
  const RENDER = {
    from: 'Riverside Pool <info@riverside.example>',
    kind: 'cancellation' as ExtractionKind,
    event: {
      title: 'Saturday swim class cancelled',
      childRef: null,
      originalTime: '2026-09-19T13:00:00.000Z',
      newTime: null,
      location: null,
    },
    teenContent: false,
    matchedEventRef: null,
    booked: false,
    going: null,
    timeZone: 'America/Toronto',
    now: NOW,
  };
  const WAS = 'Saturday, Sep 19 at 9:00 a.m.';

  it('names the sender, the occasion with the change-word taken off, and the rendered instant', () => {
    expect(factsOf(RENDER)).toMatchObject({
      sender: 'Riverside Pool',
      title: 'Saturday swim class',
      titleCarriesVerb: false,
      change: 'cancelled',
      whenLabel: WAS,
      wasLabel: null,
      place: null,
      offer: null,
      teen: false,
      calendarNotice: false,
    });
  });

  it('strips a trailing change word and relays a title that still carries a verb', () => {
    const cancelled: Array<[string, Partial<EmailAlertVoiceFacts>]> = [
      ['Saturday swim class cancelled', { title: 'Saturday swim class', titleCarriesVerb: false }],
      ['Swim Class - CANCELLED', { title: 'Swim Class', titleCarriesVerb: false }],
      ['Swim class is cancelled', { title: 'Swim class', titleCarriesVerb: false }],
      ['Swim class is now cancelled', { title: 'Swim class', titleCarriesVerb: false }],
      ['Swim class cancelled!', { title: 'Swim class', titleCarriesVerb: false }],
      [
        'Cancellation of Tuesday practice',
        { title: 'Cancellation of Tuesday practice', titleCarriesVerb: true },
      ],
      ['Swim lessons', { title: 'Swim lessons', titleCarriesVerb: false }],
    ];
    for (const [title, expectFacts] of cancelled) {
      expect(factsOf({ ...RENDER, event: { ...RENDER.event, title } })).toMatchObject({
        ...expectFacts,
        change: 'cancelled',
        whenLabel: WAS,
      });
    }

    const moved: Array<[string, Partial<EmailAlertVoiceFacts>]> = [
      ['Soccer practice moved', { title: 'Soccer practice', titleCarriesVerb: false }],
      ['Soccer practice', { title: 'Soccer practice', titleCarriesVerb: false }],
      ['Practice moved to 5pm', { title: 'Practice moved to 5pm', titleCarriesVerb: true }],
      ['Practice moves to 5pm', { title: 'Practice moves to 5pm', titleCarriesVerb: true }],
      [
        'Swim class rescheduled to Friday',
        { title: 'Swim class rescheduled to Friday', titleCarriesVerb: true },
      ],
      ['New time for swim class', { title: 'New time for swim class', titleCarriesVerb: true }],
    ];
    for (const [title, expectFacts] of moved) {
      expect(
        factsOf({
          ...RENDER,
          kind: 'reschedule',
          event: { ...RENDER.event, title, newTime: '2026-09-26T14:30:00.000Z' },
        }),
      ).toMatchObject({
        ...expectFacts,
        change: 'moved',
        whenLabel: 'Saturday, Sep 26 at 10:30 a.m.',
        wasLabel: 'Sep 19',
        offer: 'week',
      });
    }
  });

  it('drops a vendor filing label and keeps a colon that is part of the title', () => {
    expect(
      factsOf({ ...RENDER, event: { ...RENDER.event, title: 'Cancelled: Saturday swim class' } }),
    ).toMatchObject({
      title: 'Saturday swim class',
      titleCarriesVerb: false,
    });
    expect(
      factsOf({
        ...RENDER,
        kind: 'reschedule',
        event: {
          ...RENDER.event,
          title: 'Rescheduled: Picture day',
          newTime: '2026-09-26T14:30:00.000Z',
        },
      }),
    ).toMatchObject({ title: 'Picture day', titleCarriesVerb: false, change: 'moved' });
    expect(
      factsOf({
        ...RENDER,
        kind: 'reminder_only',
        from: 'YRDSB <registrar@yrdsb.example>',
        event: { ...RENDER.event, title: 'Reminder: the field trip form is due' },
      }),
    ).toMatchObject({
      sender: 'YRDSB',
      title: 'the field trip form is due',
      titleCarriesVerb: true,
      whenLabel: WAS,
      offer: 'week',
    });
    expect(
      factsOf({ ...RENDER, event: { ...RENDER.event, title: 'Swim class: bring goggles' } }),
    ).toMatchObject({
      title: 'Swim class: bring goggles',
    });
  });

  it('gives the model no occasion when the title is only the change word', () => {
    for (const title of ['CANCELLED', '']) {
      expect(factsOf({ ...RENDER, event: { ...RENDER.event, title } })).toMatchObject({
        title: null,
        change: 'cancelled',
        whenLabel: WAS,
        sender: 'Riverside Pool',
      });
    }
  });

  it('picks a time field per kind, and a place only for a new date or a booking', () => {
    expect(
      factsOf({ ...RENDER, kind: 'reschedule', event: { ...RENDER.event, title: 'Swim lessons' } }),
    ).toMatchObject({
      title: 'Swim lessons',
      change: 'moved',
      whenLabel: WAS,
      wasLabel: null,
      offer: null,
    });
    expect(
      factsOf({
        ...RENDER,
        kind: 'new_event',
        event: {
          ...RENDER.event,
          title: 'Picture day',
          originalTime: null,
          newTime: '2026-10-02T13:00:00.000Z',
          location: 'the gym',
        },
      }),
    ).toMatchObject({
      title: 'Picture day',
      titleCarriesVerb: false,
      change: null,
      whenLabel: 'Friday, Oct 2 at 9:00 a.m.',
      place: 'the gym',
      offer: 'week',
    });
    expect(
      factsOf({
        ...RENDER,
        kind: 'new_event',
        from: 'Cartwheels Gym <hello@cartwheels.example>',
        event: {
          ...RENDER.event,
          title: 'Fall registration is open',
          originalTime: null,
          newTime: '2026-10-02T13:00:00.000Z',
        },
      }),
    ).toMatchObject({
      sender: 'Cartwheels Gym',
      title: 'Fall registration is open',
      titleCarriesVerb: true,
      place: null,
    });
    expect(
      factsOf({
        ...RENDER,
        kind: 'new_event',
        event: {
          ...RENDER.event,
          title: 'Term 1 registration opens Monday',
          originalTime: null,
          newTime: '2026-10-02T13:00:00.000Z',
        },
      }),
    ).toMatchObject({ title: 'Term 1 registration opens Monday', titleCarriesVerb: true });
    expect(
      factsOf({
        ...RENDER,
        kind: 'unclear',
        event: { ...RENDER.event, title: 'a possible schedule change', originalTime: null },
      }),
    ).toMatchObject({
      title: 'a possible schedule change',
      whenLabel: null,
      change: null,
      offer: null,
    });
  });

  it('keeps a street address out and a short place in', () => {
    const place = (location: string) =>
      factsOf({
        ...RENDER,
        kind: 'new_event',
        event: {
          ...RENDER.event,
          title: 'Picture day',
          originalTime: null,
          newTime: '2026-10-02T13:00:00.000Z',
          location,
        },
      }).place;
    expect(place('the gym')).toBe('the gym');
    expect(place('120 Main St W, Markham ON L3P 1X4')).toBeNull();
  });

  it('uses the bare domain, never the full address, and drops a display name that is an address', () => {
    expect(factsOf({ ...RENDER, from: 'registrar.k12@yrdsb.example' }).sender).toBe(
      'yrdsb.example',
    );
    expect(
      factsOf({ ...RENDER, from: '"noreply@school.example" <noreply@school.example>' }).sender,
    ).toBe('school.example');
  });

  it('drops a time that is not a date, and a sender that is not a header', () => {
    expect(
      factsOf({ ...RENDER, event: { ...RENDER.event, originalTime: 'this Saturday' } }),
    ).toMatchObject({
      whenLabel: null,
      title: 'Saturday swim class',
    });
    expect(factsOf({ ...RENDER, from: 'no-at-sign-at-all' }).sender).toBeNull();
  });

  it('carries the year on a date in another year', () => {
    expect(
      factsOf({
        ...RENDER,
        kind: 'reschedule',
        event: {
          ...RENDER.event,
          title: 'Swim lessons',
          originalTime: '2026-12-30T14:00:00.000Z',
          newTime: '2027-01-05T14:00:00.000Z',
        },
      }),
    ).toMatchObject({
      whenLabel: 'Tuesday, Jan 5, 2027 at 9:00 a.m.',
      wasLabel: 'Dec 30',
    });
  });

  it('bounds a runaway title at a word boundary', () => {
    const title = factsOf({
      ...RENDER,
      event: {
        ...RENDER.event,
        title: 'Saturday swim class for beginners and improvers at the west end pool this term',
      },
    }).title;
    expect(title).toBe('Saturday swim class for beginners and improvers at the west');
    expect(title?.endsWith(' ')).toBe(false);
  });

  it('withholds the sender and the time from a teen parent', () => {
    const facts = factsOf({
      ...RENDER,
      kind: 'unclear',
      teenContent: true,
      from: 'Maple Counselling <intake@maplecounselling.example>',
      event: { ...RENDER.event, title: 'A possible schedule change' },
    });
    expect(facts).toMatchObject({
      teen: true,
      title: 'A possible schedule change',
      sender: null,
      whenLabel: null,
      offer: null,
    });
    expect(facts.withheld.join(' ')).toContain('Maple Counselling');
    expect(facts.withheld.join(' ')).toContain('maplecounselling.example');
    expect(facts.withheld.join(' ')).toContain('Sep 19');
  });

  it('folds an accent onto the letter under it', () => {
    const school = factsOf({
      ...RENDER,
      kind: 'reminder_only',
      event: { ...RENDER.event, title: 'École Côte-des-Neiges' },
    });
    expect(school.title).toBe('École Cote-des-Neiges');
    const fete = factsOf({
      ...RENDER,
      kind: 'reminder_only',
      event: { ...RENDER.event, title: "Fête de l'automne" },
    });
    expect(fete.title).toBe("Fete de l'automne");
  });

  it('shortens a long sender at the comma, not mid-phrase', () => {
    const facts = factsOf({
      ...RENDER,
      from: '"City of Toronto Parks, Forestry & Recreation" <parks@toronto.example>',
    });
    expect(facts.sender).toBe('City of Toronto Parks');
  });

  it('folds a typographic subject line into GSM-7', () => {
    const facts = factsOf({
      ...RENDER,
      from: '"Riverside\u2019s Pool" <a@b.example>',
      event: { ...RENDER.event, title: 'Leo\u2019s class \u2014 cancelled\u2026' },
    });
    expect(facts.sender).toBe("Riverside's Pool");
    expect(facts.title).toContain("Leo's class");
    expect(isPrintableGsm7Basic(`${facts.sender} ${facts.title}`)).toBe(true);
  });

  it('keeps every fact string inside two GSM-7 segments once the test echo copies them', () => {
    const nasty = 'Registration - '.repeat(40);
    const kinds: ExtractionKind[] = [
      'cancellation',
      'reschedule',
      'new_event',
      'reminder_only',
      'unclear',
      'booking_confirmation',
    ];
    const goings: Array<GoingCount | null> = [
      null,
      { shown: true, others: 2 },
      { shown: true, others: 3 },
      { shown: true, others: 99 },
      { shown: false, reason: 'below_floor' },
    ];
    const instants = [
      { originalTime: '2027-01-05T13:00:00.000Z', newTime: '2027-01-06T13:00:00.000Z' },
      { originalTime: '2027-09-28T16:00:00.000Z', newTime: '2027-09-29T16:00:00.000Z' },
    ];
    for (const kind of kinds) {
      for (const teenContent of [false, true]) {
        for (const booked of [false, true]) {
          for (const going of goings) {
            for (const times of instants) {
              for (const from of [
                `"${nasty}" <${'a'.repeat(60)}@${'d'.repeat(60)}.example>`,
                `${'x'.repeat(200)}@${'y'.repeat(80)}.example`,
                'no-at-sign-at-all',
                '',
              ]) {
                const facts = factsOf({
                  ...RENDER,
                  from,
                  kind,
                  teenContent,
                  booked,
                  going,
                  event: { title: nasty, childRef: null, ...times, location: 'somewhere' },
                });
                const line = echoEmailAlertLine(facts);
                expect(emailAlertAccepts(line, facts), line).toBe(true);
                expect(smsEncoding(line)).toBe('gsm7');
                expect(smsSegments(line)).toBeLessThanOrEqual(2);
              }
            }
          }
        }
      }
    }
  });
});

/**
 * A provider's receipt. The facts name the class and the first session. A question
 * is allowed only when a row will exist behind it (#649).
 */
describe('the booking facts', () => {
  const BOOKING: EmailAlertRenderInput = {
    from: 'Riverside Pool <info@riverside.example>',
    kind: 'booking_confirmation',
    teenContent: false,
    matchedEventRef: null,
    booked: true,
    going: null,
    timeZone: 'America/Toronto',
    now: NOW,
    event: {
      title: 'Swim Level 2',
      childRef: null,
      originalTime: null,
      newTime: '2026-09-26T13:00:00.000Z',
      location: 'the Leisure Centre',
    },
  };

  it('names the provider, the class, the first session and the place, and allows a calendar question', () => {
    expect(factsOf(BOOKING)).toMatchObject({
      sender: 'Riverside Pool',
      title: 'Swim Level 2',
      whenLabel: 'Saturday, Sep 26 at 9:00 a.m.',
      place: 'the Leisure Centre',
      offer: 'calendar',
      going: null,
    });
  });

  it('asks nothing when the class is already tracked', () => {
    const tracked = factsOf({
      ...BOOKING,
      matchedEventRef: { table: 'family_events', id: randomUUID() },
    });
    expect(tracked.offer).toBeNull();
    expect(echoEmailAlertLine(tracked)).not.toContain('?');
    expect(echoEmailAlertLine(factsOf(BOOKING)).match(/\?/g)).toHaveLength(1);
  });

  it('the test echo asserts no row Hale does not hold', () => {
    const line = echoEmailAlertLine(factsOf(BOOKING));
    expect(extractStateClaims(line)).toEqual([]);
    const banned = "Riverside Pool says you're registered for Swim Level 2.";
    expect(extractStateClaims(banned).map((claim) => claim.kind)).toEqual(['scheduled_event']);
  });

  it('is the same facts as a new_event while the flag is off', () => {
    const dark = factsOf({ ...BOOKING, booked: false });
    const asNewEvent = factsOf({ ...BOOKING, kind: 'new_event', booked: false });
    expect(dark).toEqual(asNewEvent);
    expect(dark).toMatchObject({ kind: 'new_event', offer: 'week', place: 'the Leisure Centre' });
  });

  it('names no instant and asks nothing when the receipt named no first session', () => {
    expect(
      factsOf({ ...BOOKING, event: { ...BOOKING.event, newTime: null, location: null } }),
    ).toMatchObject({ whenLabel: null, place: null, offer: null, title: 'Swim Level 2' });
  });

  it('keeps the teen text category-only', () => {
    expect(factsOf({ ...BOOKING, teenContent: true })).toMatchObject({
      teen: true,
      title: 'Swim Level 2',
      sender: null,
      whenLabel: null,
      offer: null,
    });
  });
});

const RENDER_FOR_OFFER = {
  from: 'Riverside Pool <info@riverside.example>',
  kind: 'new_event' as ExtractionKind,
  teenContent: false,
  matchedEventRef: null,
  booked: false,
  going: null as GoingCount | null,
  timeZone: 'America/Toronto',
  now: NOW,
};

describe('the offer at the end', () => {
  /**
   * The sentence Hale may end on, and the row that has to exist before it may say it.
   *
   * #649 removed "I can add it to your week - reply YES" because nothing consumed the YES:
   * a parent doing what the text said reached the coach with nothing drafted, or, with one
   * unrelated action pending, approved THAT one. So the two halves are asserted together
   * in every test here — a text with the clause and no row is the bug coming back, and a
   * row with no clause is a question nobody was asked that makes every bare affirmative in
   * the household ambiguous for a day.
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

  it('writes ONE offer row against the text that carried the clause', async () => {
    const h = harness({ classification: future({ location: 'the gym' }) });

    await expect(alert(h)).resolves.toBe('sent');

    const body = h.transport.sent[0]?.body ?? '';
    expect(body).toContain('Picture day');
    expect(body).toContain('Friday, Oct 2 at 9:00 a.m.');
    expect(body).toContain('?');
    expect(body).not.toMatch(/Reply YES/i);
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
    // This start is more than a day out, so the start cap does not bind.
    expect(offer.expiresAt.getTime() - NOW.getTime()).toBe(EMAIL_ALERT_OFFER_TTL_MS);
  });

  it('caps the offer at the occasion start when that is inside a day', async () => {
    const startsAt = new Date(NOW.getTime() + 6 * 60 * 60 * 1000);
    const h = harness({
      classification: future({ newTime: startsAt.toISOString(), location: 'the gym' }),
    });

    await expect(alert(h)).resolves.toBe('sent');

    const offers = await offerRows();
    expect(offers).toHaveLength(1);
    expect(offers[0]?.startsAt.toISOString()).toBe(startsAt.toISOString());
    expect(offers[0]?.expiresAt.toISOString()).toBe(startsAt.toISOString());
  });

  it('does not offer an occasion the connected calendar already holds', async () => {
    const gcal = await seedIntegration(db.database, family.familyId, family.parentUserId, 'gcal');
    const startsAt = new Date('2026-10-02T13:00:00.000Z');
    await db.database.insert(schema.parentCalendarBlocks).values({
      integrationId: gcal,
      eventId: 'evt-picture-day',
      familyId: family.familyId,
      userId: family.parentUserId,
      startAt: startsAt,
      endAt: new Date(startsAt.getTime() + 60 * 60 * 1000),
      kidRelated: true,
      title: 'Picture day',
      status: 'confirmed',
      updatedStamp: '1',
    });
    const h = harness({ classification: future({ location: 'the gym' }) });

    await expect(alert(h)).resolves.toBe('sent');

    const body = h.transport.sent[0]?.body ?? '';
    expect(body).toContain('Picture day');
    expect(body).not.toContain('?');
    expect(body).not.toMatch(/Reply YES/i);
    await expect(offerRows()).resolves.toEqual([]);
  });

  it('holds the CTA and the row to the same decision, shape by shape', async () => {
    // Each of these is a way the sentence would be untrue. The pairing is the assertion:
    // no row means no clause, and no clause means no row, in one table so a future shape
    // cannot be given one without the other.
    const silent: Array<[string, SentinelClassification]> = [
      // A cancellation is the REMOVAL of a date; putting it on the week is the opposite.
      ['a cancellation', classified()],
      // Hale could not tell what the email was.
      ['an unreadable email', classified({ kind: 'unclear' })],
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

      expect(h.transport.sent[0]?.body, why).not.toContain('?');
      expect(h.transport.sent[0]?.body, why).not.toContain('YES');
      await expect(offerRows(), why).resolves.toHaveLength(0);
    }
  });

  it('does not offer an occasion the family already tracks', async () => {
    // A reschedule of a class Hale already holds would be PLACED BESIDE the old one - two
    // copies of one Saturday, from a text that promised to tidy it.
    const matched = future({ kind: 'reschedule' });
    const extraction = matched.extraction;
    if (!extraction) throw new Error('fixture lost its extraction');
    extraction.matchedEventRef = { table: 'family_events', id: randomUUID() };
    const h = harness({ classification: matched });

    await expect(alert(h)).resolves.toBe('sent');

    expect(h.transport.sent[0]?.body).not.toContain('?');
    expect(h.transport.sent[0]?.body).not.toContain('YES');
    await expect(offerRows()).resolves.toHaveLength(0);
  });

  it('names a Google Calendar event and does not offer to add it', async () => {
    // The event is already on the parent's calendar. "Reply YES and it goes on your
    // week" asks them to add it again. The notice is the name and the time.
    const when = '2026-10-01T20:15:00.000Z';
    const from = 'Google Calendar <calendar-notification@google.com>';
    const event = {
      title: 'Gymnastics',
      childRef: null,
      originalTime: when,
      newTime: null,
      location: 'the gym',
    };
    const notice = factsOf({
      ...RENDER_FOR_OFFER,
      from,
      kind: 'reminder_only',
      event,
    });
    expect(notice).toMatchObject({
      calendarNotice: true,
      title: 'Gymnastics',
      whenLabel: 'Thursday, Oct 1 at 4:15 p.m.',
      sender: null,
      place: null,
      offer: null,
    });
    expect(notice.withheld).toContain('Google Calendar');
    expect(echoEmailAlertLine(notice)).toBe('Gymnastics on Thursday, Oct 1 at 4:15 p.m.');
    // The classifier may file the same reminder as a new date. Same notice, and the
    // place stays off it: the parent already has the event.
    expect(
      factsOf({
        ...RENDER_FOR_OFFER,
        from,
        kind: 'new_event',
        event: { ...event, originalTime: null, newTime: when },
      }),
    ).toMatchObject({
      calendarNotice: true,
      title: 'Gymnastics',
      whenLabel: 'Thursday, Oct 1 at 4:15 p.m.',
      sender: null,
      place: null,
      offer: null,
    });
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

    // The address alone is enough. A display name that is not Google Calendar is not.
    expect(
      factsOf({
        ...RENDER_FOR_OFFER,
        from: 'calendar-notification@google.com',
        kind: 'reminder_only',
        event,
      }),
    ).toMatchObject({
      calendarNotice: true,
      title: 'Gymnastics',
      whenLabel: notice.whenLabel,
      offer: null,
      sender: null,
    });
    const school = factsOf({
      ...RENDER_FOR_OFFER,
      from: 'Google Classroom <classroom-noreply@google.com>',
      kind: 'new_event',
      event: { ...event, originalTime: null, newTime: when, location: null },
    });
    expect(school).toMatchObject({
      calendarNotice: false,
      sender: 'Google Classroom',
      title: 'Gymnastics',
      whenLabel: 'Thursday, Oct 1 at 4:15 p.m.',
      offer: 'week',
    });

    const h = harness({
      classification: classified({
        kind: 'reminder_only',
        title: 'Gymnastics',
        originalTime: when,
        newTime: null,
        location: 'the gym',
      }),
    });
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
    expect(h.transport.sent[0]?.body).toBe(echoEmailAlertLine(notice));
    expect(h.threaded[0]?.body).toBe(echoEmailAlertLine(notice));
    await expect(offerRows()).resolves.toHaveLength(0);
  });

  it('keeps a calendar cancellation as the change, still with no offer', () => {
    const body = factsOf({
      ...RENDER_FOR_OFFER,
      from: 'Google Calendar <calendar-notification@google.com>',
      kind: 'cancellation',
      event: {
        title: 'Gymnastics',
        childRef: null,
        originalTime: '2026-10-01T20:15:00.000Z',
        newTime: null,
        location: null,
      },
    });
    expect(body).toMatchObject({
      sender: 'Google Calendar',
      title: 'Gymnastics',
      change: 'cancelled',
      whenLabel: 'Thursday, Oct 1 at 4:15 p.m.',
      offer: null,
      calendarNotice: false,
    });
    // A move is still the change. It is already on the calendar, so it is not an offer.
    const moved = factsOf({
      ...RENDER_FOR_OFFER,
      from: 'Google Calendar <calendar-notification@google.com>',
      kind: 'reschedule',
      event: {
        title: 'Gymnastics',
        childRef: null,
        originalTime: '2026-10-01T20:15:00.000Z',
        newTime: '2026-10-02T20:15:00.000Z',
        location: null,
      },
    });
    expect(moved).toMatchObject({
      change: 'moved',
      whenLabel: 'Friday, Oct 2 at 4:15 p.m.',
      wasLabel: 'Oct 1',
      offer: null,
    });
  });

  it('allows one question only when a row will exist, and never for a teen', () => {
    const facts = factsOf({
      ...RENDER_FOR_OFFER,
      event: {
        title: 'Picture day',
        childRef: null,
        originalTime: null,
        newTime: '2026-10-02T13:00:00.000Z',
        location: null,
      },
    });
    expect(facts).toMatchObject({
      title: 'Picture day',
      whenLabel: 'Friday, Oct 2 at 9:00 a.m.',
      offer: 'week',
    });
    expect(echoEmailAlertLine(facts).match(/\?/g)).toHaveLength(1);
    expect(echoEmailAlertLine(facts)).not.toMatch(/Reply YES/i);

    const teen = factsOf({
      ...RENDER_FOR_OFFER,
      teenContent: true,
      event: {
        title: 'a message about school',
        childRef: null,
        originalTime: null,
        newTime: '2026-10-02T13:00:00.000Z',
        location: null,
      },
    });
    expect(teen.offer).toBeNull();
    expect(echoEmailAlertLine(teen)).not.toContain('?');
  });
});

describe('the gate registration', () => {
  it('counts email alerts on their OWN budget, three a day', () => {
    // Kills PROACTIVE_CATEGORY.email_alert = 'nudge', which would let one school notice
    // spend a household's weekly nudge budget.
    expect(PROACTIVE_CATEGORY.email_alert).toBe('email_alert');
    expect(PROACTIVE_CAP.email_alert).toEqual({ max: 3, windowHours: 24 });
  });
});

/**
 * WHO ELSE IS GOING — the clause inside the frame, the fold that measures it, and the dark
 * state that never asks.
 *
 * The count itself is `going.pglite.test.ts`'s job (the SQL, the floor, the key). What is
 * under test here is everything the alert path does with an answer: where the words land,
 * what the audit row carries, and — the one that cannot be seen from the count's side —
 * that a dark sweep never issues the query at all.
 */
describe('who else is going', () => {
  const BOOKING: EmailAlertRenderInput = {
    from: 'Riverside Pool <info@riverside.example>',
    kind: 'booking_confirmation',
    teenContent: false,
    matchedEventRef: null,
    booked: true,
    going: null,
    timeZone: 'America/Toronto',
    now: NOW,
    event: {
      title: 'Swim Level 2',
      childRef: null,
      originalTime: null,
      newTime: '2026-09-26T13:00:00.000Z',
      location: 'the Leisure Centre',
    },
  };

  it('hands the model the count clause verbatim, and only for a booking', () => {
    const spoken = emailAlertVoiceFacts({ ...BOOKING, going: { shown: true, others: 2 } });
    expect(spoken.facts.going).toBe(', with two other Hale families');
    expect(spoken.going).toEqual({ shown: true, others: 2 });
    const line = echoEmailAlertLine(spoken.facts);
    expect(line).toContain(', with two other Hale families');
    expect(emailAlertAccepts(line, spoken.facts)).toBe(true);
  });

  it('names the POPULATION it counts — Hale families, never families', () => {
    const facts = emailAlertVoiceFacts({ ...BOOKING, going: { shown: true, others: 3 } }).facts;
    expect(facts.going).toBe(', with three other Hale families');
    const line = echoEmailAlertLine(facts);
    expect(line).toContain('three other Hale families');
    expect(line).not.toMatch(/(?<!Hale )other families/);
  });

  it('adds NO state claim, and the banned wording does — the mutation, executed', () => {
    const line = echoEmailAlertLine(
      emailAlertVoiceFacts({ ...BOOKING, going: { shown: true, others: 2 } }).facts,
    );
    expect(extractStateClaims(line)).toEqual([]);
    expect(
      extractStateClaims(
        line
          .replace(', with two other Hale families', '')
          .replace('.', ' and two other Hale families are booked.'),
      ).length,
    ).toBeGreaterThan(0);
  });

  it('drops the clause on the retry when the line does not fit, and keeps it when it does', async () => {
    const max: EmailAlertRenderInput = {
      ...BOOKING,
      from: `"${'S'.repeat(60)}" <info@brookfield.example>`,
      event: {
        title: 'T'.repeat(80),
        childRef: null,
        originalTime: null,
        newTime: '2027-09-29T16:00:00.000Z',
        location: 'L'.repeat(30),
      },
    };
    const spoken = emailAlertVoiceFacts({ ...max, going: { shown: true, others: 3 } });
    expect(spoken.facts.going).toContain('three other Hale families');
    const fitted = echoEmailAlertLine(spoken.facts);
    expect(emailAlertAccepts(fitted, spoken.facts)).toBe(true);
    expect(smsSegments(fitted)).toBeLessThanOrEqual(2);

    const tooLong = `${fitted}${'x'.repeat(400)}`;
    expect(smsSegments(tooLong)).toBeGreaterThan(2);
    const written = await writeEmailAlert(spoken.facts, {
      attempt: async (tryFacts, tryIndex) =>
        tryIndex === 0 ? tooLong : echoEmailAlertLine(tryFacts),
      alert: async () => undefined,
    });
    expect(written?.going).toBeNull();
    expect(written?.line).not.toContain('Hale families');
    expect(
      written ? emailAlertAccepts(written.line, { ...spoken.facts, going: null }) : false,
    ).toBe(true);
  });

  it('omits the clause for every refusal, the same as no count at all', () => {
    const none = emailAlertVoiceFacts({ ...BOOKING, going: null }).facts;
    expect(none.going).toBeNull();
    for (const reason of ['below_floor', 'no_session', 'repeat_receipt', 'going_dark'] as const) {
      expect(emailAlertVoiceFacts({ ...BOOKING, going: { shown: false, reason } }).facts).toEqual(
        none,
      );
    }
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
    expect(h.transport.sent[0]?.body).toContain('with two other Hale families');

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
    expect(h.transport.sent[0]?.body).not.toContain('Hale families');
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
    expect(second.transport.sent[0]?.body).not.toContain('Hale families');
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
    expect(first.transport.sent[0]?.body).toContain('with two other Hale families');

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
    expect(second.transport.sent[0]?.body).not.toContain('Hale families');

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

  it('DARK: the query is not issued at all, and the body is byte-identical', async () => {
    await otherFamilyBooked('Other A');
    await otherFamilyBooked('Other B');
    const lit = harness({ classification: receipt() });
    vi.stubEnv(GOING_COUNT_ENABLED_ENV, 'true');
    await alertPair(lit, 'm1', { envelope: RECEIPT });
    const spoken = lit.transport.sent[0]?.body ?? '';

    // ...and now with the flag in its `vercel env add` failure shape.
    vi.stubEnv(GOING_COUNT_ENABLED_ENV, 'true\n');
    const dark = harness({ classification: receipt() });
    const { sql, out } = await statementsDuring(() => alertPair(dark, 'm2', { envelope: RECEIPT }));
    expect(out.going).toBe('going_dark');
    expect(sql.some((text) => text.includes(COUNT_QUERY))).toBe(false);
    expect(dark.transport.sent[0]?.body).toBe(spoken.replace(', with two other Hale families', ''));
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
    expect(h.transport.sent[0]?.body).not.toContain('Hale families');
  });

  it('ERASURE: deleting one counted family drops the count and the clause with it', async () => {
    vi.stubEnv(GOING_COUNT_ENABLED_ENV, 'true');
    const erasedId = await otherFamilyBooked('Other A');
    await otherFamilyBooked('Other B');
    // THE POSITIVE CONTROL FIRST, on a household of its own: without it the assertion below
    // passes on a count that was never 2. Note that this leg WRITES a third booking, which
    // is why both it and Other A are erased next - the claim is about the cascade, and a
    // count that fell because one household was never in it would prove nothing.
    const control = await sweepDetail('Third', 'm1');
    expect(control.result.going).toBe('shown');
    expect(control.body).toContain('with two other Hale families');

    // The cascade IS the erasure path - `runDeletionSweep` issues one DELETE FROM families
    // and lets it take the bookings - so it is asserted rather than trusted, and the count
    // is a query rather than an aggregate precisely so nothing has to recompute.
    await db.database
      .delete(schema.families)
      .where(inArray(schema.families.id, [erasedId, control.familyId]));

    const { result, body } = await sweepDetail('Fifth', 'm2');
    expect(result.going).toBe('below_floor');
    expect(body).not.toContain('Hale families');
  });

  /** One fresh household receiving this same receipt - the shape both erasure legs need. */
  async function sweepDetail(
    name: string,
    messageId: string,
  ): Promise<{ familyId: string; result: EmailAlertResult; body: string }> {
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
    return { familyId: household.familyId, result, body: h.transport.sent[0]?.body ?? '' };
  }
});
