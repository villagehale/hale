import { randomUUID } from 'node:crypto';
import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeTransport } from '~/lib/channel/intake/transport';
import { OPT_OUT_LINE } from '~/lib/channel/opt-out';
import { PROACTIVE_CAP, PROACTIVE_CATEGORY } from '~/lib/channel/outbound-gate';
import { extractStateClaims } from '~/lib/channel/reconcile/claims';
import { isPrintableGsm7Basic, smsSegments } from '~/lib/channel/sms-segments';
import { TwilioSendError } from '~/lib/channel/twilio/transport';
import type { ExtractedEvent, ExtractionKind, SentinelClassification } from '~/lib/sentinel';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { EMAIL_ALERT_OFFER_TTL_MS } from './email-alert-offer';
import {
  EMAIL_ALERT_MAX_PER_SWEEP,
  EMAIL_ALERT_TEMPLATE_KEY,
  type EmailAlertOutcome,
  type EmailAlertPorts,
  type EmailAlertRenderInput,
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
      expect(body).toContain('Saturday swim class');
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
    matchedEventRef: null,
    // DARK by default, so every frame below is asserted against the behaviour every
    // family has today. The booking frame's own describe arms it explicitly.
    booked: false,
    timeZone: 'America/Toronto',
    now: NOW,
  };

  /**
   * The ONE clause this render may add after its sentence — see `emailAlertOfferDraft`.
   *
   * The frame tests below are about the SENTENCE, so they read the body with the clause
   * taken off, in one place rather than as `+ CTA` on seventeen table rows. Whether the
   * clause is there at all, and where it lands, is what `the offer at the end` asserts —
   * including every shape that must NOT carry it, so stripping here cannot hide one.
   */
  const CTA = ' Reply YES and it goes on your week.';
  const frame = (input: EmailAlertRenderInput): string =>
    renderEmailAlert(input).replace(CTA, '');

  it('is a plain sentence: the sender did it, the time is a clause, and it ends there', () => {
    // The first cut opened "From your email:" and closed "I can add it to your week -
    // reply YES", and the founder's note on both was the same one: a person telling you
    // about a text does not narrate where they read it, and does not offer what they
    // cannot do. NOTHING consumes that YES — an email alert registers no open question of
    // any kind (lib/channel/router/open-questions.ts: nine kinds, none of them this), so
    // a parent who replied YES either got the coach or, with one unrelated draft pending,
    // approved THAT. The offer is gone until something can keep it.
    const body = renderEmailAlert(RENDER);
    expect(body).toBe(
      'Riverside Pool cancelled Saturday swim class - it was Saturday, Sep 19 at 9:00 a.m.',
    );
    expect(body).not.toContain('From your email');
    expect(body).not.toContain('YES');
  });

  it('never says the change twice, whatever the extraction put in the title', () => {
    // The skill's contract for `title` is bare (`"title": string`) and the shipped
    // fixtures carry the verb — 'Swim Class - CANCELLED', 'Soccer practice moved'
    // (lib/sentinel/correlate.test.ts). So Hale takes the vendor's trailing verb off and
    // says it itself; where the word is EMBEDDED and cannot be cleanly removed, it
    // relays the title under "says" and adds no second verb.
    const cancelled: Array<[string, string]> = [
      ['Saturday swim class cancelled', 'Riverside Pool cancelled Saturday swim class'],
      ['Swim Class - CANCELLED', 'Riverside Pool cancelled Swim Class'],
      ['Swim class is cancelled', 'Riverside Pool cancelled Swim class'],
      // Two auxiliaries, which is how a vendor writes it: the tail has to take the whole
      // 'is now cancelled' or it leaves a dangling 'is' behind as the occasion.
      ['Swim class is now cancelled', 'Riverside Pool cancelled Swim class'],
      ['Swim class cancelled!', 'Riverside Pool cancelled Swim class'],
      ['Cancellation of Tuesday practice', 'Riverside Pool says Cancellation of Tuesday practice'],
      // The CONTROL. Without it every row above passes on a renderer that simply never
      // says "cancelled" — which is the other way to lose the sentence.
      ['Swim lessons', 'Riverside Pool cancelled Swim lessons'],
    ];
    for (const [title, head] of cancelled) {
      const body = frame({ ...RENDER, event: { ...RENDER.event, title } });
      expect(body).toBe(`${head} - it was Saturday, Sep 19 at 9:00 a.m.`);
      expect(body).not.toMatch(/cancelled[^.]*\bcancelled\b/i);
    }

    // A reschedule's destination is the half that doubles: a title carrying the verb in
    // its MIDDLE is relayed under "says", and "says Practice moved to 5pm TO Saturday" is
    // the vendor's sentence and Hale's welded into one. Relayed titles get the same dash
    // clause a relayed cancellation gets.
    const moved: Array<[string, string]> = [
      ['Soccer practice moved', 'Riverside Pool moved Soccer practice to Saturday, Sep 26'],
      // The CONTROL: a title with no verb in it at all must still say what happened.
      ['Soccer practice', 'Riverside Pool moved Soccer practice to Saturday, Sep 26'],
      ['Practice moved to 5pm', 'Riverside Pool says Practice moved to 5pm - now Saturday, Sep 26'],
      // The PRESENT tense of the same sentence. A frame that tests for 'moved' and not
      // 'moves' writes Hale's destination onto the vendor's, and the sentence carries two.
      ['Practice moves to 5pm', 'Riverside Pool says Practice moves to 5pm - now Saturday, Sep 26'],
      [
        'Swim class rescheduled to Friday',
        'Riverside Pool says Swim class rescheduled to Friday - now Saturday, Sep 26',
      ],
      [
        'New time for swim class',
        'Riverside Pool says New time for swim class - now Saturday, Sep 26',
      ],
    ];
    for (const [title, head] of moved) {
      const body = frame({
        ...RENDER,
        kind: 'reschedule',
        event: { ...RENDER.event, title, newTime: '2026-09-26T14:30:00.000Z' },
      });
      expect(body).toBe(`${head} at 10:30 a.m. (was Sep 19).`);
      // One destination per sentence, whichever frame carried it.
      expect(body).not.toMatch(/\bto\b[^.]*\bto\b/);
      expect(body).not.toMatch(/moved[^.]*\bmoved\b/i);
    }
  });

  it('drops the vendor label in front of a subject line, and keeps a real colon', () => {
    // 'Reminder:', 'Cancelled -', 'New:' are the sender's own filing system. Hale's
    // sentence already says which kind of thing this is, so relaying the label says it
    // twice in someone else's voice.
    const sentence = (over: Partial<EmailAlertRenderInput>) =>
      frame({ ...RENDER, ...over } as EmailAlertRenderInput);

    expect(sentence({ event: { ...RENDER.event, title: 'Cancelled: Saturday swim class' } })).toBe(
      'Riverside Pool cancelled Saturday swim class - it was Saturday, Sep 19 at 9:00 a.m.',
    );
    expect(
      sentence({
        kind: 'reschedule',
        event: {
          ...RENDER.event,
          title: 'Rescheduled: Picture day',
          newTime: '2026-09-26T14:30:00.000Z',
        },
      }),
    ).toBe('Riverside Pool moved Picture day to Saturday, Sep 26 at 10:30 a.m. (was Sep 19).');
    expect(
      sentence({
        kind: 'reminder_only',
        from: 'YRDSB <registrar@yrdsb.example>',
        event: { ...RENDER.event, title: 'Reminder: the field trip form is due' },
      }),
    ).toBe('YRDSB says the field trip form is due - Saturday, Sep 19 at 9:00 a.m.');
    // The CONTROL: a colon that is part of what the school actually said stays.
    expect(sentence({ event: { ...RENDER.event, title: 'Swim class: bring goggles' } })).toBe(
      'Riverside Pool cancelled Swim class: bring goggles - it was Saturday, Sep 19 at 9:00 a.m.',
    );
  });

  it("names the occasion in Hale's own word when the title is only the change", () => {
    // 'CANCELLED' as the whole title leaves nothing to name. Relaying it under "says"
    // puts a vendor's shout in Hale's mouth; the frame keeps its verb and its own object.
    for (const title of ['CANCELLED', '']) {
      expect(frame({ ...RENDER, event: { ...RENDER.event, title } })).toBe(
        'Riverside Pool cancelled something - it was Saturday, Sep 19 at 9:00 a.m.',
      );
    }
  });

  it('has a sentence for every kind the extraction can return', () => {
    const sentence = (over: Partial<EmailAlertRenderInput>) =>
      frame({ ...RENDER, ...over } as EmailAlertRenderInput);

    // A reschedule Hale only knows the OLD time for still says what happened.
    expect(
      sentence({ kind: 'reschedule', event: { ...RENDER.event, title: 'Swim lessons' } }),
    ).toBe('Riverside Pool moved Swim lessons - it was Saturday, Sep 19 at 9:00 a.m.');
    expect(
      sentence({
        kind: 'new_event',
        event: {
          ...RENDER.event,
          title: 'Picture day',
          originalTime: null,
          newTime: '2026-10-02T13:00:00.000Z',
          location: 'the gym',
        },
      }),
    ).toBe('Riverside Pool has Picture day at the gym on Friday, Oct 2 at 9:00 a.m.');
    // A title that is already a CLAUSE cannot be the object of "has". Ollie's own frame
    // for this exact line is "Cartwheels says Fall/Term 1 registration is open".
    expect(
      sentence({
        kind: 'new_event',
        from: 'Cartwheels Gym <hello@cartwheels.example>',
        event: {
          ...RENDER.event,
          title: 'Fall registration is open',
          originalTime: null,
          newTime: '2026-10-02T13:00:00.000Z',
        },
      }),
    ).toBe('Cartwheels Gym says Fall registration is open - Friday, Oct 2 at 9:00 a.m.');
    // Ollie's canonical registration line has a finite verb and no copula — the shape a
    // copula-only test lets through, and "has Term 1 registration opens Monday" is what
    // that costs.
    expect(
      sentence({
        kind: 'new_event',
        from: 'Cartwheels Gym <hello@cartwheels.example>',
        event: {
          ...RENDER.event,
          title: 'Term 1 registration opens Monday',
          originalTime: null,
          newTime: '2026-10-02T13:00:00.000Z',
        },
      }),
    ).toBe('Cartwheels Gym says Term 1 registration opens Monday - Friday, Oct 2 at 9:00 a.m.');
    expect(
      sentence({
        kind: 'reminder_only',
        from: 'YRDSB <registrar@yrdsb.example>',
        event: { ...RENDER.event, title: 'the field trip permission form is due' },
      }),
    ).toBe('YRDSB says the field trip permission form is due - Saturday, Sep 19 at 9:00 a.m.');
    expect(
      sentence({
        kind: 'unclear',
        event: { ...RENDER.event, title: 'a possible schedule change', originalTime: null },
      }),
    ).toBe('Riverside Pool sent something about a possible schedule change.');
  });

  it('picks the frame by ONE question — does the title already carry a verb', () => {
    // The class of bug this table exists to end: each round found another inflection the
    // frame had not been told about ('moved' but not 'moves', 'is' but not 'opens'), and
    // each fix named that one word. So the frame is decided ONCE, by a single question
    // about the title, and each answer has exactly one shape:
    //   YES, it carries a verb -> relay it whole under "says" and hang the time off a
    //        dash. Never a second verb, never a second destination.
    //   NO, it is a noun phrase -> Hale supplies the verb (cancelled / moved / has).
    // A TRAILING change word comes off first, and what is left is what gets asked.
    const MOVED_TO = '2026-09-26T14:30:00.000Z';
    const WAS = 'it was Saturday, Sep 19 at 9:00 a.m.';
    const NOW_AT = 'Saturday, Sep 26 at 10:30 a.m.';
    const rows: Array<{ kind: ExtractionKind; title: string; from?: string; body: string }> = [
      // Noun phrase: Hale's verb, and the time on Hale's preposition.
      {
        kind: 'cancellation',
        title: 'Swim lessons',
        body: `Riverside Pool cancelled Swim lessons - ${WAS}`,
      },
      // Past tense as a tail: taken off, then the noun phrase underneath.
      {
        kind: 'cancellation',
        title: 'Saturday swim class cancelled',
        body: `Riverside Pool cancelled Saturday swim class - ${WAS}`,
      },
      // 'is now' — two auxiliaries in front of the tail.
      {
        kind: 'cancellation',
        title: 'Swim class is now cancelled',
        body: `Riverside Pool cancelled Swim class - ${WAS}`,
      },
      // A vendor label is the sender's filing system, not a verb.
      {
        kind: 'cancellation',
        title: 'Cancelled: Saturday swim class',
        body: `Riverside Pool cancelled Saturday swim class - ${WAS}`,
      },
      // The change word is EMBEDDED and cannot come off cleanly: relay, no second verb.
      {
        kind: 'cancellation',
        title: 'Cancellation of Tuesday practice',
        body: `Riverside Pool says Cancellation of Tuesday practice - ${WAS}`,
      },
      {
        kind: 'reschedule',
        title: 'Soccer practice',
        body: `Riverside Pool moved Soccer practice to ${NOW_AT} (was Sep 19).`,
      },
      {
        kind: 'reschedule',
        title: 'Soccer practice moved',
        body: `Riverside Pool moved Soccer practice to ${NOW_AT} (was Sep 19).`,
      },
      // Present progressive as a tail.
      {
        kind: 'reschedule',
        title: 'Swim class is moving',
        body: `Riverside Pool moved Swim class to ${NOW_AT} (was Sep 19).`,
      },
      // Present tense with the vendor's OWN destination in it: relayed, dash clause, one
      // 'to' in the whole sentence.
      {
        kind: 'reschedule',
        title: 'Practice moves to 5pm',
        body: `Riverside Pool says Practice moves to 5pm - now ${NOW_AT} (was Sep 19).`,
      },
      {
        kind: 'reschedule',
        title: 'Rescheduled: Picture day',
        body: `Riverside Pool moved Picture day to ${NOW_AT} (was Sep 19).`,
      },
      {
        kind: 'new_event',
        title: 'Picture day',
        body: `Riverside Pool has Picture day on ${NOW_AT}`,
      },
      // Ollie's registration line, present tense and no copula.
      {
        kind: 'new_event',
        title: 'Term 1 registration opens Monday',
        body: `Riverside Pool says Term 1 registration opens Monday - ${NOW_AT}`,
      },
      {
        kind: 'new_event',
        title: 'Fall registration is open',
        body: `Riverside Pool says Fall registration is open - ${NOW_AT}`,
      },
      // A display name carries the sender's full stop the way a subject line does, and it
      // lands in the middle of Hale's sentence.
      {
        kind: 'new_event',
        title: 'Picture day',
        from: 'Riverside Pool. <info@riverside.example>',
        body: `Riverside Pool has Picture day on ${NOW_AT}`,
      },
      // A reminder that is a noun phrase is an occasion, not a thing to say out loud:
      // "says Pediatric checkup - Saturday" is a dash standing in for the verb.
      {
        kind: 'reminder_only',
        title: 'Pediatric checkup',
        body: 'Riverside Pool has Pediatric checkup on Saturday, Sep 19 at 9:00 a.m.',
      },
      {
        kind: 'reminder_only',
        title: 'the field trip form is due',
        body: 'Riverside Pool says the field trip form is due - Saturday, Sep 19 at 9:00 a.m.',
      },
      {
        kind: 'reminder_only',
        title: 'Registration opens Monday',
        body: 'Riverside Pool says Registration opens Monday - Saturday, Sep 19 at 9:00 a.m.',
      },
      {
        kind: 'unclear',
        title: 'a possible schedule change',
        body: 'Riverside Pool sent something about a possible schedule change.',
      },
    ];

    for (const row of rows) {
      const body = frame({
        ...RENDER,
        kind: row.kind,
        from: row.from ?? RENDER.from,
        event: {
          ...RENDER.event,
          title: row.title,
          newTime: row.kind === 'reschedule' || row.kind === 'new_event' ? MOVED_TO : null,
        },
      });
      expect(body).toBe(row.body);
      // On EVERY row: one destination per sentence. Two 'to's is the vendor's verb and
      // Hale's both carrying the new time.
      expect(body).not.toMatch(/\bto\b[^.]*\bto\b/);
    }
  });

  it('keeps a street address out of the sentence and a short place in it', () => {
    // A room number or a street line is the one thing in a school email a text should not
    // repeat: it is long, it is the part a parent already knows, and it is the part that
    // makes an SMS a copy of the email.
    const newEvent = (location: string) =>
      frame({
        ...RENDER,
        kind: 'new_event',
        event: {
          ...RENDER.event,
          title: 'Picture day',
          originalTime: null,
          newTime: '2026-10-02T13:00:00.000Z',
          location,
        },
      });
    expect(newEvent('the gym')).toContain('at the gym on');
    expect(newEvent('120 Main St W, Markham ON L3P 1X4')).toBe(
      'Riverside Pool has Picture day on Friday, Oct 2 at 9:00 a.m.',
    );
  });

  it('falls back to the bare DOMAIN as the subject, never the full address', () => {
    // An address in a text is a mailbox anyone holding the phone can write to. A domain
    // reads perfectly well as the subject of a sentence.
    const body = frame({ ...RENDER, from: 'registrar.k12@yrdsb.example' });
    expect(body).toBe(
      'yrdsb.example cancelled Saturday swim class - it was Saturday, Sep 19 at 9:00 a.m.',
    );
    expect(body).not.toContain('registrar.k12');
  });

  it('drops a display NAME that is itself an address — the commonest no-reply header', () => {
    // `"noreply@school.example" <noreply@school.example>` is what school and daycare
    // systems put in From, so reading the display name is reading the address out loud.
    // Any '@' in the label means the domain is the honest half of it.
    const body = frame({
      ...RENDER,
      from: '"noreply@school.example" <noreply@school.example>',
    });
    expect(body).toContain('school.example cancelled ');
    expect(body).not.toContain('noreply@');
  });

  it('says only what happened when the extraction found no usable time', () => {
    expect(
      frame({
        ...RENDER,
        kind: 'reminder_only',
        event: { ...RENDER.event, title: 'the field trip form is due', originalTime: null },
      }),
    ).toBe('Riverside Pool says the field trip form is due.');
  });

  it('drops a time the model did not write as a date', () => {
    // `original_time` is a model's free text. "Invalid Date" in a parent's phone is worse
    // than no time at all.
    expect(
      frame({ ...RENDER, event: { ...RENDER.event, originalTime: 'this Saturday' } }),
    ).toBe('Riverside Pool cancelled Saturday swim class.');
  });

  it('carries the YEAR on a date in another year, in both halves of a reschedule', () => {
    expect(
      frame({
        ...RENDER,
        kind: 'reschedule',
        event: {
          ...RENDER.event,
          title: 'Swim lessons',
          originalTime: '2026-12-30T14:00:00.000Z',
          newTime: '2027-01-05T14:00:00.000Z',
        },
      }),
    ).toBe('Riverside Pool moved Swim lessons to Tuesday, Jan 5, 2027 at 9:00 a.m. (was Dec 30).');
  });

  it('bounds a runaway title at a word boundary and still ends the sentence', () => {
    const body = frame({
      ...RENDER,
      event: {
        ...RENDER.event,
        title: 'Saturday swim class for beginners and improvers at the west end pool this term',
      },
    });
    expect(body).toBe(
      'Riverside Pool cancelled Saturday swim class for beginners and improvers at the west - it was Saturday, Sep 19 at 9:00 a.m.',
    );
  });

  it('tells a teen parent the CATEGORY and nothing else — no sender, no time, no offer', () => {
    // The pipeline has already genericized the title by the time this sees it; dropping
    // the sender and the time is this renderer's half of rule #1, because a clinic's
    // domain and a Thursday 4pm are the disclosure.
    const body = frame({
      ...RENDER,
      kind: 'unclear',
      teenContent: true,
      from: 'Maple Counselling <intake@maplecounselling.example>',
      event: { ...RENDER.event, title: 'A possible schedule change' },
    });

    expect(body).toBe("A possible schedule change. I've kept the details out of this text.");
    expect(body).not.toContain('maplecounselling');
    expect(body).not.toContain('Maple Counselling');
    expect(body).not.toContain('Sep 19');
  });

  it('folds a typographic subject line back into GSM-7 rather than paying UCS-2 for it', () => {
    // One curly apostrophe flips the WHOLE body to UCS-2 and halves the segment budget,
    // for a difference nobody reading it on a phone can see.
    const body = frame({
      ...RENDER,
      from: '"Riverside’s Pool" <a@b.example>',
      event: { ...RENDER.event, title: 'Leo’s class — cancelled…' },
    });
    expect(body).toContain("Riverside's Pool cancelled Leo's class");
    expect(isPrintableGsm7Basic(body)).toBe(true);
  });

  it('still names the change when the header carries no sender at all', () => {
    // `senderLabel` returns '' for a malformed From with no '@'. With no subject there is
    // no Ollie sentence to write, so the occasion becomes the subject — never a stand-in
    // sender, which would be a fact Hale invented.
    expect(frame({ ...RENDER, from: 'no-at-sign-at-all' })).toBe(
      'Saturday swim class cancelled - it was Saturday, Sep 19 at 9:00 a.m.',
    );
  });

  it('holds two GSM-7 segments including the FULL opt-out, for every shape it can render', () => {
    // The budget is what makes the clamps load-bearing: remove SENDER_MAX or TITLE_MAX and
    // one verbose school subject line becomes a three-segment bill per family per email.
    // The OFFER CLAUSE is inside this bound too — `renderEmailAlert` is called here, not
    // `frame` — because the shapes that can carry it are exactly the long ones.
    const nasty = 'Registration — '.repeat(40);
    const kinds: ExtractionKind[] = [
      'cancellation',
      'reschedule',
      'new_event',
      'reminder_only',
      'unclear',
      'booking_confirmation',
    ];
    for (const kind of kinds) {
      for (const teenContent of [false, true]) {
        // BOTH flag states, because the booking frame and its longer CTA only exist in
        // one of them: a bound proved dark is a bound proved on the old sentence.
        for (const booked of [false, true]) {
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
              booked,
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
    }
  });
});

/**
 * THE BOOKING SENTENCE — a provider's receipt, and the one question it may end on.
 *
 * Two things are being pinned here and they are not the same thing. The FRAME says what
 * the email said and nothing more, which is a claim-taxonomy question. The CTA is a
 * question asked if and only if a row will exist behind it, which is #649's question. The
 * tests below keep them apart on purpose, because the way this ships wrong is a frame
 * that carries the question itself.
 */
describe('the booking frame', () => {
  const BOOKING: EmailAlertRenderInput = {
    from: 'Riverside Pool <info@riverside.example>',
    kind: 'booking_confirmation',
    teenContent: false,
    matchedEventRef: null,
    booked: true,
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

  it('relays the provider as the subject, names the first session, and ends on the one ask', () => {
    expect(renderEmailAlert(BOOKING)).toBe(
      "Riverside Pool says you're in for Swim Level 2 - first one Saturday, Sep 26 at 9:00 a.m." +
        ' at the Leisure Centre. Want it on your calendar?',
    );
  });

  it('carries NO question in the frame - only the CTA slot may ask one', () => {
    // The class is already on the family's calendar, so `emailAlertOfferDraft` refuses and
    // no CTA is appended. What is left IS the composed frame, and it must not ask
    // anything: a question with no offer row behind it is #649 verbatim, and after the
    // correlation fix this is the most common draft-null booking there is.
    const tracked = renderEmailAlert({
      ...BOOKING,
      matchedEventRef: { table: 'family_events', id: randomUUID() },
    });
    expect(tracked).toBe(
      "Riverside Pool says you're in for Swim Level 2 - first one Saturday, Sep 26 at 9:00 a.m." +
        ' at the Leisure Centre.',
    );
    expect(tracked).not.toContain('?');
    // MUTATION: move 'Want it on your calendar?' inside `compose` and this goes red,
    // while the happy-path assertion above stays green. That asymmetry is the test.
    expect(renderEmailAlert(BOOKING).match(/\?/g)).toHaveLength(1);
  });

  it('asserts no row Hale does not hold - the claim taxonomy, with its mutation', () => {
    // SCHEDULED_ASSERTION matches "you're registered", "is confirmed", "is on your
    // calendar". "you're in for" and "Want it on your calendar?" clear it, and the
    // email-alert path runs no `refuseUnbackedSend`, so this file is the only gate.
    expect(extractStateClaims(renderEmailAlert(BOOKING))).toEqual([]);

    // THE MUTATION, as an executable control rather than a note: the same sentence with
    // the banned wording DOES produce a claim. Without it this is an absence test, and
    // absence tests fail open.
    const banned = "Riverside Pool says you're registered for Swim Level 2.";
    expect(extractStateClaims(banned).map((claim) => claim.kind)).toEqual(['scheduled_event']);
  });

  it('renders byte-identically to a new_event while the flag is off', () => {
    // The WHOLE claim of the dark state, asserted rather than narrated. Same extraction,
    // same instant, same everything: dark, a booking IS a new_event on the wire.
    const dark = renderEmailAlert({ ...BOOKING, booked: false });
    const asNewEvent = renderEmailAlert({ ...BOOKING, kind: 'new_event', booked: false });
    expect(dark).toBe(asNewEvent);
    expect(dark).toBe(
      'Riverside Pool has Swim Level 2 at the Leisure Centre on Saturday, Sep 26 at 9:00 a.m.' +
        ' Reply YES and it goes on your week.',
    );
  });

  it('says only what it has when the receipt named no first session', () => {
    const undated = renderEmailAlert({
      ...BOOKING,
      event: { ...BOOKING.event, newTime: null, location: null },
    });
    // No instant means no offer (`emailAlertOfferDraft`'s concrete-time condition), so no
    // CTA either - the sentence stops where the evidence does.
    expect(undated).toBe("Riverside Pool says you're in for Swim Level 2.");
  });

  it('keeps the teen text category-only, as every other kind does', () => {
    expect(renderEmailAlert({ ...BOOKING, teenContent: true })).toBe(
      "Swim Level 2. I've kept the details out of this text.",
    );
  });
});

const RENDER_FOR_OFFER = {
  from: 'Riverside Pool <info@riverside.example>',
  kind: 'new_event' as ExtractionKind,
  teenContent: false,
  matchedEventRef: null,
  booked: false,
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
  const CTA = 'Reply YES and it goes on your week.';

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

    expect(h.transport.sent[0]?.body).toContain(CTA);
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

    expect(h.transport.sent[0]?.body).not.toContain('YES');
    await expect(offerRows()).resolves.toHaveLength(0);
  });

  it('puts the clause after the sentence ends, once, and never inside a teen text', () => {
    const body = renderEmailAlert({
      ...RENDER_FOR_OFFER,
      event: {
        title: 'Picture day',
        childRef: null,
        originalTime: null,
        newTime: '2026-10-02T13:00:00.000Z',
        location: null,
      },
    });
    expect(body).toBe(`Riverside Pool has Picture day on Friday, Oct 2 at 9:00 a.m. ${CTA}`);
    expect(body.match(/Reply YES/g)).toHaveLength(1);

    // The teen text is category-only and returns before the frame runs at all.
    expect(
      renderEmailAlert({
        ...RENDER_FOR_OFFER,
        teenContent: true,
        event: {
          title: 'a message about school',
          childRef: null,
          originalTime: null,
          newTime: '2026-10-02T13:00:00.000Z',
          location: null,
        },
      }),
    ).not.toContain('YES');
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
