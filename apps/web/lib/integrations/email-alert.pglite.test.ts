import { randomUUID } from 'node:crypto';
import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeTransport } from '~/lib/channel/intake/transport';
import { LinqSendError } from '~/lib/channel/linq/transport';
import { PROACTIVE_CATEGORY } from '~/lib/channel/outbound-gate';
import type { ExtractedEvent, ExtractionKind, SentinelClassification } from '~/lib/sentinel';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import {
  type EmailAlertOutcome,
  type EmailAlertPorts,
  type EmailAlertResult,
  type GmailAlertEnvelope,
  alertParentForEmail,
  alertParentForGmailSweep,
} from './email-alert';

/**
 * A parenting email is recorded as a booking and the parent is not texted.
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

function harness(
  over: {
    classification?: SentinelClassification;
    classifyThrows?: boolean;
    verdict?: Awaited<ReturnType<EmailAlertPorts['gate']>>;
    phone?: string | null;
    sendThrows?: LinqSendError;
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
  beforeEach(() => {
    vi.stubEnv('BOOKED_DETECTION_ENABLED', 'true');
  });

  it('records the mail and sends nothing: no ledger row, no thread, no text', async () => {
    const h = harness();

    await expect(alertPair(h)).resolves.toEqual({
      alert: 'backfill_suppressed',
      booking: 'not_a_booking',
      going: null,
    });

    expect(h.transport.sent).toEqual([]);
    expect(h.threaded).toEqual([]);
    expect(h.classifyCalls).toBe(1);
    await expect(ledgerRows()).resolves.toEqual([]);
    const audit = await auditRows();
    expect(audit.map((row) => row.actionTaken)).not.toContain('email_alert_sent');
  });

  it('still runs for a family that is not on the F14 allowlist when F14_ENABLED is exactly true', async () => {
    vi.stubEnv('F14_ENABLED', 'true');
    vi.stubEnv('F14_FAMILY_ALLOWLIST', '00000000-0000-4000-8000-000000000000');
    const h = harness();

    await expect(alert(h)).resolves.toBe('backfill_suppressed');
    expect(h.transport.sent).toEqual([]);
    expect(h.classifyCalls).toBe(1);
  });

  it('is dark behind F14 — no classifier call, no text, nothing written', async () => {
    vi.stubEnv('F14_ENABLED', 'false');
    const h = harness();

    await expect(alert(h)).resolves.toBe('dark');

    expect(h.classifyCalls).toBe(0);
    expect(h.transport.sent).toEqual([]);
    await expect(ledgerRows()).resolves.toEqual([]);
  });

  it('a second pass over the same message still sends nothing', async () => {
    const first = harness();
    await expect(alert(first)).resolves.toBe('backfill_suppressed');

    const second = harness();
    await expect(alert(second)).resolves.toBe('backfill_suppressed');
    expect(second.transport.sent).toEqual([]);
    await expect(ledgerRows()).resolves.toEqual([]);
  });

  it('a DIFFERENT message in the same mailbox is still read', async () => {
    await expect(alert(harness())).resolves.toBe('backfill_suppressed');
    await expect(alert(harness(), 'm2')).resolves.toBe('backfill_suppressed');
    await expect(ledgerRows()).resolves.toEqual([]);
  });

  it('a newsletter is triaged out: no ledger claim', async () => {
    const h = harness({ classification: TRIAGED_OUT });

    await expect(alert(h)).resolves.toBe('not_parenting');

    expect(h.transport.sent).toEqual([]);
    await expect(ledgerRows()).resolves.toEqual([]);
    await expect(alert(harness())).resolves.toBe('backfill_suppressed');
  });

  it('a refusing gate does not stop the record and sends nothing', async () => {
    const held = harness({ verdict: { allowed: false, reason: 'quiet_hours' } });
    await expect(alert(held)).resolves.toBe('backfill_suppressed');
    expect(held.transport.sent).toEqual([]);
    await expect(ledgerRows()).resolves.toEqual([]);
  });

  it('a classifier that throws is a named outcome, never a throw into the sweep', async () => {
    const h = harness({ classifyThrows: true });
    await expect(alert(h)).resolves.toBe('classifier_failed');
    await expect(ledgerRows()).resolves.toEqual([]);
  });

  it('a throwing transport is irrelevant: nothing is sent and no channel row is claimed', async () => {
    const h = harness({ sendThrows: new LinqSendError('21610', 400, true) });
    await expect(alert(h)).resolves.toBe('backfill_suppressed');
    expect(h.transport.sent).toEqual([]);
    await expect(ledgerRows()).resolves.toEqual([]);
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

  it('reads every dated envelope, newest first, and texts none of them', async () => {
    vi.stubEnv('BOOKED_DETECTION_ENABLED', 'true');
    const h = harness();
    const envelopes = Array.from({ length: 12 }, (_, i) =>
      envelope(i + 1, `2026-09-17T${String(i + 1).padStart(2, '0')}:00:00.000Z`),
    );

    const outcomes = await sweep(h, { envelopes });

    expect(outcomes.filter((o) => o === 'backfill_suppressed')).toHaveLength(12);
    expect(h.classifyCalls).toBe(12);
    expect(h.transport.sent).toEqual([]);
    const rows = await ledgerRows();
    expect(rows).toEqual([]);
  });

  it('skips a message Gmail gave no internalDate for, and still reads the rest', async () => {
    vi.stubEnv('BOOKED_DETECTION_ENABLED', 'true');
    const h = harness();
    const outcomes = await sweep(h, {
      envelopes: [envelope(1), envelope(2, '2026-09-17T10:00:00.000Z')],
    });
    expect(outcomes).toEqual(['no_received_at', 'backfill_suppressed']);
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

  it('alertParentForEmail: lane exactly true records the mail and writes no offer', async () => {
    vi.stubEnv('EMAIL_ALERT_ENABLED', 'true');
    vi.stubEnv('BOOKED_DETECTION_ENABLED', 'true');
    const h = harness({ classification: offerable() });

    await expect(alertPair(h)).resolves.toMatchObject({
      alert: 'backfill_suppressed',
      going: null,
    });

    expect(h.transport.sent).toEqual([]);
    await expect(offerRows()).resolves.toEqual([]);
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

  it('alertParentForGmailSweep: the backfill pass is held by its caller, not by the lane flag', async () => {
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

  it('alertParentForGmailSweep: lane exactly true records the dated mail and texts none of it', async () => {
    vi.stubEnv('EMAIL_ALERT_ENABLED', 'true');
    const h = harness({ classification: offerable() });
    vi.spyOn(console, 'info').mockImplementation(() => {});

    const outcomes = await alertParentForGmailSweep(db.database, sweepInput(), h.ports);

    expect(outcomes.map((o) => o.alert)).toEqual(['no_received_at', 'backfill_suppressed']);
    expect(h.transport.sent).toEqual([]);
    await expect(offerRows()).resolves.toEqual([]);
  });
});

describe('the gate registration', () => {
  it('keeps email alerts on their own category', () => {
    expect(PROACTIVE_CATEGORY.email_alert).toBe('email_alert');
  });
});
