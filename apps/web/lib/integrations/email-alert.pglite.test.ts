import { randomUUID } from 'node:crypto';
import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeTransport } from '~/lib/channel/intake/transport';
import { OPT_OUT_LINE } from '~/lib/channel/opt-out';
import { PROACTIVE_CAP, PROACTIVE_CATEGORY } from '~/lib/channel/outbound-gate';
import { isPrintableGsm7Basic, smsSegments } from '~/lib/channel/sms-segments';
import { TwilioSendError } from '~/lib/channel/twilio/transport';
import type { ExtractedEvent, ExtractionKind, SentinelClassification } from '~/lib/sentinel';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import {
  EMAIL_ALERT_MAX_PER_SWEEP,
  EMAIL_ALERT_TEMPLATE_KEY,
  type EmailAlertOutcome,
  type EmailAlertPorts,
  type GmailAlertEnvelope,
  alertParentForEmail,
  alertParentForGmailSweep,
  emailAlertDedupeKey,
  renderEmailAlert,
} from './email-alert';

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
  over: Partial<ExtractedEvent> & { kind?: ExtractionKind; teenContent?: boolean } = {},
): SentinelClassification {
  const { kind = 'cancellation', teenContent = false, ...event } = over;
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

function harness(
  over: {
    classification?: SentinelClassification;
    classifyThrows?: boolean;
    verdict?: Awaited<ReturnType<EmailAlertPorts['gate']>>;
    phone?: string | null;
    sendThrows?: TwilioSendError;
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
    },
  };
  return h;
}

function alert(h: Harness, messageId = 'm1') {
  return alertParentForEmail(
    db.database,
    {
      familyId: family.familyId,
      parentUserId: family.parentUserId,
      integrationId: INTEGRATION,
      messageId,
      envelope: ENVELOPE,
      timeZone: 'America/Toronto',
      now: NOW,
    },
    h.ports,
  );
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
    // The COMPOSED sentence goes in the thread, not the wire body: the CASL line belongs
    // on the wire and nowhere else (channel/thread.ts).
    expect(h.threaded).toHaveLength(1);
    expect(h.threaded[0]?.body).not.toContain(OPT_OUT_LINE);
    expect(h.transport.sent[0]?.body).toContain(OPT_OUT_LINE);
  });

  it('carries the EXTRACTION and no line of the email — not the snippet, not the subject', async () => {
    // Rule #1, as the only assertion that can fail when the email itself starts riding
    // along. The positive control is the pair: the extraction's own title MUST be there,
    // so the two `not.toContain`s cannot pass on an empty or truncated body.
    const h = harness();
    await expect(alert(h)).resolves.toBe('sent');

    for (const body of [h.transport.sent[0]?.body, h.threaded[0]?.body]) {
      expect(body).toContain('Saturday swim class cancelled');
      expect(body).not.toContain(ENVELOPE.snippet);
      expect(body).not.toContain(ENVELOPE.subject);
      expect(body).not.toContain('Leo');
    }
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
    const h = harness({ sendThrows: new TwilioSendError('21610', 400) });
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

describe('the text itself', () => {
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
    timeZone: 'America/Toronto',
    now: NOW,
  };

  it('leads with the sender and the change, and closes with the offer', () => {
    expect(renderEmailAlert(RENDER)).toBe(
      'From your email: Riverside Pool - Saturday swim class cancelled. Was Sep 19, 9:00 a.m. I can add it to your week - reply YES.',
    );
  });

  it('falls back to the bare DOMAIN, never the full address', () => {
    // An address in a text is a mailbox anyone holding the phone can write to.
    const body = renderEmailAlert({ ...RENDER, from: 'registrar.k12@yrdsb.example' });
    expect(body).toContain('From your email: yrdsb.example - ');
    expect(body).not.toContain('registrar.k12');
  });

  it('drops a display NAME that is itself an address — the commonest no-reply header', () => {
    // `"noreply@school.example" <noreply@school.example>` is what school and daycare
    // systems put in From, so reading the display name is reading the address out loud.
    // Any '@' in the label means the domain is the honest half of it.
    const body = renderEmailAlert({
      ...RENDER,
      from: '"noreply@school.example" <noreply@school.example>',
    });
    expect(body).toContain('From your email: school.example - ');
    expect(body).not.toContain('noreply@');
  });

  it('says only the title when the extraction found no usable time', () => {
    expect(
      renderEmailAlert({
        ...RENDER,
        kind: 'reminder_only',
        event: { ...RENDER.event, title: 'Field trip form due', originalTime: null },
      }),
    ).toBe(
      'From your email: Riverside Pool - Field trip form due. I can add it to your week - reply YES.',
    );
  });

  it('reads a reschedule off the NEW time and a new event off its own', () => {
    expect(
      renderEmailAlert({
        ...RENDER,
        kind: 'reschedule',
        event: { ...RENDER.event, title: 'Swim moved', newTime: '2026-09-26T14:30:00.000Z' },
      }),
    ).toContain('Now Sep 26, 10:30 a.m.');
    expect(
      renderEmailAlert({
        ...RENDER,
        kind: 'new_event',
        event: {
          ...RENDER.event,
          title: 'Picture day',
          originalTime: null,
          newTime: '2026-10-02T13:00:00.000Z',
        },
      }),
    ).toContain('Picture day. Oct 2, 9:00 a.m.');
  });

  it('drops a time the model did not write as a date', () => {
    // `original_time` is a model's free text. "Invalid Date" in a parent's phone is worse
    // than no time at all.
    expect(
      renderEmailAlert({ ...RENDER, event: { ...RENDER.event, originalTime: 'this Saturday' } }),
    ).toBe(
      'From your email: Riverside Pool - Saturday swim class cancelled. I can add it to your week - reply YES.',
    );
  });

  it('tells a teen parent the CATEGORY and nothing else — no sender, no time, no offer', () => {
    // The pipeline has already genericized the title by the time this sees it; dropping
    // the sender and the time is this renderer's half of rule #1, because a clinic's
    // domain and a Thursday 4pm are the disclosure.
    const body = renderEmailAlert({
      ...RENDER,
      kind: 'unclear',
      teenContent: true,
      from: 'Maple Counselling <intake@maplecounselling.example>',
      event: { ...RENDER.event, title: 'A possible schedule change' },
    });

    expect(body).toBe(
      "From your email: A possible schedule change. I've kept the details out of this text.",
    );
    expect(body).not.toContain('maplecounselling');
    expect(body).not.toContain('Maple Counselling');
    expect(body).not.toContain('Sep 19');
  });

  it('folds a typographic subject line back into GSM-7 rather than paying UCS-2 for it', () => {
    // One curly apostrophe flips the WHOLE body to UCS-2 and halves the segment budget,
    // for a difference nobody reading it on a phone can see.
    const body = renderEmailAlert({
      ...RENDER,
      from: '"Riverside’s Pool" <a@b.example>',
      event: { ...RENDER.event, title: 'Leo’s class — cancelled…' },
    });
    expect(body).toContain("Riverside's Pool - Leo's class - cancelled...");
    expect(isPrintableGsm7Basic(body)).toBe(true);
  });

  it('holds two GSM-7 segments including the FULL opt-out, for every shape it can render', () => {
    // The budget is what makes the clamps load-bearing: remove SENDER_MAX or TITLE_MAX and
    // one verbose school subject line becomes a three-segment bill per family per email.
    const nasty = 'Registration — '.repeat(40);
    const kinds: ExtractionKind[] = [
      'cancellation',
      'reschedule',
      'new_event',
      'reminder_only',
      'unclear',
    ];
    for (const kind of kinds) {
      for (const teenContent of [false, true]) {
        for (const from of [
          `"${nasty}" <${'a'.repeat(60)}@${'d'.repeat(60)}.example>`,
          `${'x'.repeat(200)}@${'y'.repeat(80)}.example`,
          'no-at-sign-at-all',
          '',
        ]) {
          const body = renderEmailAlert({
            ...RENDER,
            from,
            kind,
            teenContent,
            event: {
              title: nasty,
              childRef: null,
              originalTime: '2027-01-05T13:00:00.000Z',
              newTime: '2027-01-06T13:00:00.000Z',
              location: 'somewhere',
            },
          });
          expect(isPrintableGsm7Basic(body)).toBe(true);
          expect(smsSegments(`${body}\n\n${OPT_OUT_LINE}`)).toBeLessThanOrEqual(2);
        }
      }
    }
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
