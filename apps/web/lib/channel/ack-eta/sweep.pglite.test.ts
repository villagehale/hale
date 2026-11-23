import { schema } from '@hale/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { holdSender } from '~/lib/channel/intake/opt-out-hold';
import { type ChannelTransport, FakeTransport } from '~/lib/channel/intake/transport';
import { WATCH_CONSENT_SCOPE } from '~/lib/channel/intake/watch-consent';
import { LinqSendError } from '~/lib/channel/linq/transport';
import { inProactiveQuietHours, proactiveFloorOpensAt } from '~/lib/channel/outbound-gate';
import { auditTurnLedger } from '~/lib/channel/router/wiring';
import { POLICY_VERSION } from '~/lib/consent';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { loadTrailForFamily } from '~/lib/dashboard/trail-query';
import { AUDIT_LOG_AUDIENCE_ENABLED_ENV } from '~/lib/privacy/audit-audience';
import { assembleFamilyExport } from '~/lib/rights/export';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import type { AckCompose, AckLineWriter, LateNoteFacts } from './compose';
import { ackDeadlinePorts } from './production';
import { recordAckPromise, recordLateNote, settleAckPromise } from './promise';
import {
  ACK_LATE_NOTE_STALE_MS,
  ACK_NOTE_WRITE_HEADROOM_MS,
  ACK_SWEEP_BATCH,
  ACK_SWEEP_BUDGET_MS,
  type AckDeadlinePorts,
  runAckDeadlineSweep,
} from './sweep';
import { retryCeilingMs } from './window';

/**
 * VIL-717 · the deadline sweep against the real DDL and the real turn ledger. The writer is
 * a stand-in that returns a line it was handed: what the model writes is the cached eval's
 * job (rule #8). What is under test is the bookkeeping: which promise owes a note, that it
 * goes once, and that every ending is named on the row and in an audit row.
 */

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
}, 120_000);

afterAll(async () => {
  await db.close();
});

afterEach(async () => {
  await db.exec('truncate table families, users cascade');
});

const ASKED_AT = new Date('2025-11-20T15:00:00.000Z');
const ACK_AT = new Date('2025-11-20T15:00:20.000Z');
const PROMISED_MINUTES = 5;
const DUE_AT = new Date(ACK_AT.getTime() + PROMISED_MINUTES * 60_000);
const AFTER_DUE = new Date(DUE_AT.getTime() + 30_000);

async function seedPromise(
  channel: 'sms' | 'imessage' = 'imessage',
  times: { askedAt: Date; ackAt: Date } = { askedAt: ASKED_AT, ackAt: ACK_AT },
) {
  const { familyId, parentUserId } = await seedFamily(db.database);
  const [inbound] = await db.database
    .insert(schema.channelMessages)
    .values({
      familyId,
      parentUserId,
      channel,
      direction: 'in',
      category: 'reply',
      status: 'delivered',
      body: 'an invented slow ask',
      providerChatId: channel === 'imessage' ? 'chat-one' : null,
    })
    .returning({ id: schema.channelMessages.id });
  const [ack] = await db.database
    .insert(schema.channelMessages)
    .values({
      familyId,
      parentUserId,
      channel,
      direction: 'out',
      category: 'reply',
      status: 'sent',
      templateKey: 'ack_eta',
    })
    .returning({ id: schema.channelMessages.id });
  if (!inbound || !ack) throw new Error('seed: channel_messages insert returned no row');
  const recorded = await recordAckPromise(db.database, {
    familyId,
    parentUserId,
    inboundChannelMessageId: inbound.id,
    ackChannelMessageId: ack.id,
    task: 'find',
    channel,
    providerChatId: channel === 'imessage' ? 'chat-one' : null,
    replyToMessageId: channel === 'imessage' ? 'parent-msg-1' : null,
    language: 'en',
    askedAt: times.askedAt,
    promisedMinutes: PROMISED_MINUTES,
    now: times.ackAt,
  });
  if (recorded.status !== 'recorded') throw new Error(`seed: promise ${recorded.status}`);
  return { familyId, parentUserId, inboundId: inbound.id, promiseId: recorded.promiseId };
}

function ports(overrides: Partial<AckDeadlinePorts> & { line?: AckCompose } = {}) {
  const facts: LateNoteFacts[] = [];
  const pages: unknown[] = [];
  const threaded: string[] = [];
  const transport = new FakeTransport();
  const { line, ...rest } = overrides;
  const built: AckDeadlinePorts = {
    enabled: () => true,
    clock: () => Date.now(),
    writer: {
      ack: async () => ({ status: 'unavailable', reason: 'client_unavailable' }),
      lateNote: async (input) => {
        facts.push(input);
        return line ?? { status: 'composed', line: 'a stand-in late note' };
      },
    },
    f14For: () => true,
    gate: async () => ({ allowed: true, optOut: 'short' }),
    quietUntil: async () => null,
    lineHold: async () => null,
    phone: async () => '+15550000000',
    transport,
    page: async (page) => {
      pages.push(page);
      return 'paged';
    },
    thread: async ({ body }) => {
      threaded.push(body);
    },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    ...rest,
  };
  return { ports: built, facts, pages, threaded, transport };
}

async function promiseRow(id: string) {
  const [row] = await db.database
    .select()
    .from(schema.ackPromises)
    .where(eq(schema.ackPromises.id, id));
  return row;
}

/** The promise's own audit rows. They are keyed on the adult, and name the promise in `after`. */
async function deadlineAudits(promiseId: string) {
  const rows = await db.database
    .select({ after: schema.auditLog.after, audience: schema.auditLog.audience })
    .from(schema.auditLog)
    .where(
      and(
        inArray(schema.auditLog.actionTaken, ['ack_eta_promised', 'ack_eta_deadline']),
        sql`${schema.auditLog.after}->>'promise' = ${promiseId}`,
      ),
    );
  return rows.map(({ after, audience }) => {
    const { promise: _promise, ...rest } = after as Record<string, unknown>;
    return { after: rest, audience };
  });
}

describe('VIL-717 · the deadline sweep', () => {
  it('writes one promise per text: a second write for the same text is already_promised', async () => {
    const seeded = await seedPromise();
    const [ackRow] = await db.database
      .select({ id: schema.ackPromises.ackChannelMessageId })
      .from(schema.ackPromises)
      .where(eq(schema.ackPromises.id, seeded.promiseId));
    const again = await recordAckPromise(db.database, {
      familyId: seeded.familyId,
      parentUserId: seeded.parentUserId,
      inboundChannelMessageId: seeded.inboundId,
      ackChannelMessageId: ackRow?.id ?? '',
      task: 'find',
      channel: 'imessage',
      providerChatId: 'chat-one',
      replyToMessageId: 'parent-msg-1',
      language: 'en',
      askedAt: ASKED_AT,
      promisedMinutes: PROMISED_MINUTES,
      now: ACK_AT,
    });
    expect(again).toEqual({ status: 'already_promised' });
    const audits = await deadlineAudits(seeded.promiseId);
    expect(audits).toEqual([
      {
        after: { task: 'find', promisedMinutes: PROMISED_MINUTES, channel: 'imessage' },
        audience: seeded.parentUserId,
      },
    ]);
  });

  it('writes no promise on a Preview deploy, because Production sweeps the shared table', async () => {
    const seeded = await seedPromise();
    const [row] = await db.database
      .select({ ack: schema.ackPromises.ackChannelMessageId })
      .from(schema.ackPromises)
      .where(eq(schema.ackPromises.id, seeded.promiseId));
    await db.database.delete(schema.ackPromises).where(eq(schema.ackPromises.id, seeded.promiseId));
    const input = {
      familyId: seeded.familyId,
      parentUserId: seeded.parentUserId,
      inboundChannelMessageId: seeded.inboundId,
      ackChannelMessageId: row?.ack ?? '',
      task: 'find' as const,
      channel: 'imessage' as const,
      providerChatId: 'chat-one',
      replyToMessageId: 'parent-msg-1',
      language: 'en',
      askedAt: ASKED_AT,
      promisedMinutes: PROMISED_MINUTES,
      now: ACK_AT,
    };
    const rows = () =>
      db.database
        .select({ id: schema.ackPromises.id })
        .from(schema.ackPromises)
        .where(eq(schema.ackPromises.inboundChannelMessageId, seeded.inboundId));

    vi.stubEnv('VERCEL_ENV', 'preview');
    expect(await recordAckPromise(db.database, input)).toEqual({
      status: 'not_recorded',
      reason: 'preview',
    });
    expect(await rows()).toEqual([]);

    vi.stubEnv('VERCEL_ENV', 'production');
    expect(await recordAckPromise(db.database, input)).toMatchObject({ status: 'recorded' });
    expect(await rows()).toHaveLength(1);
  });

  it('reads nothing before the window closes', async () => {
    await seedPromise();
    const p = ports();
    const summary = await runAckDeadlineSweep(
      db.database,
      p.ports,
      new Date(DUE_AT.getTime() - 1_000),
    );
    expect(summary).toMatchObject({ due: 0, claimed: 0 });
    expect(p.transport.sent).toEqual([]);
  });

  it('settles as answered, and sends nothing, when the turn ledger answered the text', async () => {
    const seeded = await seedPromise();
    // The production writer of the answered row, not a hand-made one.
    await auditTurnLedger(db.database).recordAnswered({
      familyId: seeded.familyId,
      parentUserId: seeded.parentUserId,
      channelMessageId: seeded.inboundId,
      folded: [],
    });
    const p = ports();

    const summary = await runAckDeadlineSweep(db.database, p.ports, AFTER_DUE);

    expect(summary.settled).toEqual({ answered: 1 });
    expect(p.facts).toEqual([]);
    expect(p.transport.sent).toEqual([]);
    expect(await promiseRow(seeded.promiseId)).toMatchObject({ outcome: 'answered' });
  });

  it('sends one still-working note under the ask, with a later window, and never a second', async () => {
    const seeded = await seedPromise('imessage');
    const p = ports();

    const first = await runAckDeadlineSweep(db.database, p.ports, AFTER_DUE);
    const second = await runAckDeadlineSweep(
      db.database,
      p.ports,
      new Date(AFTER_DUE.getTime() + 60_000),
    );

    expect(first.settled).toEqual({ sent: 1 });
    expect(second).toMatchObject({ due: 0, claimed: 0 });
    expect(p.transport.sent).toEqual([
      {
        to: '+15550000000',
        replyIn: {
          chatId: 'chat-one',
          messageId: 'parent-msg-1',
          plainResendOnlyIfRefused: true,
        },
        body: 'a stand-in late note',
        sendKey: `ack_eta_late_note:${seeded.promiseId}`,
      },
    ]);
    expect(p.facts).toHaveLength(1);
    const facts = p.facts[0];
    expect(facts?.status).toBe('still_working');
    expect(facts?.minutesSinceAsk).toBe(5);
    // A new window that is later than the one already missed.
    expect(facts?.newWithinMinutes ?? 0).toBeGreaterThan(PROMISED_MINUTES);
    expect(p.threaded).toEqual(['a stand-in late note']);

    const row = await promiseRow(seeded.promiseId);
    expect(row?.outcome).toBe('sent');
    expect(row?.noteChannelMessageId).not.toBeNull();
    const [note] = await db.database
      .select({
        templateKey: schema.channelMessages.templateKey,
        body: schema.channelMessages.body,
      })
      .from(schema.channelMessages)
      .where(eq(schema.channelMessages.id, row?.noteChannelMessageId ?? ''));
    // No words stored on the ledger row (rule #1).
    expect(note).toEqual({ templateKey: 'ack_eta_late_note', body: null });
  });

  it('says nothing more is coming, and promises no time, when the turn ended unanswered', async () => {
    const seeded = await seedPromise('sms');
    await auditTurnLedger(db.database).recordRouted({ channelMessageId: seeded.inboundId });
    const p = ports();

    await runAckDeadlineSweep(db.database, p.ports, AFTER_DUE);

    expect(p.facts.map((f) => [f.status, f.newWithinMinutes])).toEqual([['stopped', null]]);
    expect(p.transport.sent.map((s) => ({ to: s.to, replyIn: s.replyIn }))).toEqual([
      { to: '+15550000000', replyIn: undefined },
    ]);
  });

  it('owes the note when the turn was claimed but nothing reached the parent', async () => {
    const seeded = await seedPromise('sms');
    await auditTurnLedger(db.database).recordAnswered({
      familyId: seeded.familyId,
      parentUserId: seeded.parentUserId,
      channelMessageId: seeded.inboundId,
      folded: [],
      nothingSent: true,
    });
    const p = ports();

    const summary = await runAckDeadlineSweep(db.database, p.ports, AFTER_DUE);

    expect(summary.settled).toEqual({ sent: 1 });
    expect(p.facts.map((f) => [f.status, f.newWithinMinutes])).toEqual([['stopped', null]]);
    expect(p.transport.bodies()).toEqual(['a stand-in late note']);
  });

  it('owes the note when the turn a text was folded into closed with nothing sent', async () => {
    const seeded = await seedPromise('sms');
    const [anchor] = await db.database
      .insert(schema.channelMessages)
      .values({
        familyId: seeded.familyId,
        parentUserId: seeded.parentUserId,
        channel: 'sms',
        direction: 'in',
        category: 'reply',
        status: 'delivered',
        body: 'an invented later text',
      })
      .returning({ id: schema.channelMessages.id });
    if (!anchor) throw new Error('seed: anchor insert returned no row');
    await auditTurnLedger(db.database).recordAnswered({
      familyId: seeded.familyId,
      parentUserId: seeded.parentUserId,
      channelMessageId: anchor.id,
      folded: [seeded.inboundId],
      nothingSent: true,
    });
    const p = ports();

    await runAckDeadlineSweep(db.database, p.ports, AFTER_DUE);

    expect(p.facts.map((f) => f.status)).toEqual(['stopped']);
  });

  it('stops starting notes past its share of the tick, and the rest stay owed', async () => {
    const first = await seedPromise();
    const second = await seedPromise();
    let clock = 0;
    const p = ports({ clock: () => clock });
    const lateNote = p.ports.writer.lateNote;
    p.ports.writer = {
      ...p.ports.writer,
      lateNote: async (facts) => {
        clock += ACK_SWEEP_BUDGET_MS;
        return lateNote(facts);
      },
    };

    const tick = await runAckDeadlineSweep(db.database, p.ports, AFTER_DUE);
    expect(tick).toMatchObject({ due: 2, claimed: 1, deferred: 1 });
    expect(p.transport.sent).toHaveLength(1);

    const next = await runAckDeadlineSweep(
      db.database,
      p.ports,
      new Date(AFTER_DUE.getTime() + 60_000),
    );
    expect(next).toMatchObject({ due: 1, claimed: 1, deferred: 0 });
    expect(p.transport.sent.map((sent) => sent.sendKey).sort()).toEqual(
      [`ack_eta_late_note:${first.promiseId}`, `ack_eta_late_note:${second.promiseId}`].sort(),
    );
  });

  it('sends nothing and pages #ops when no note can be written', async () => {
    const seeded = await seedPromise();
    const p = ports({ line: { status: 'unavailable', reason: 'gate_exhausted' } });

    await runAckDeadlineSweep(db.database, p.ports, AFTER_DUE);

    expect(p.transport.sent).toEqual([]);
    expect(p.pages).toEqual([{ stage: 'late_note', reason: 'gate_exhausted' }]);
    expect(await promiseRow(seeded.promiseId)).toMatchObject({ outcome: 'unwritten' });
    const audits = await deadlineAudits(seeded.promiseId);
    expect(audits.map((a) => a.after)).toContainEqual({
      outcome: 'unwritten',
      reason: 'gate_exhausted',
    });
  });

  it('drops a note it reaches long after the window, and one a rail holds', async () => {
    const stale = await seedPromise();
    const p = ports();
    await runAckDeadlineSweep(
      db.database,
      p.ports,
      new Date(DUE_AT.getTime() + ACK_LATE_NOTE_STALE_MS + 1_000),
    );
    expect(await promiseRow(stale.promiseId)).toMatchObject({ outcome: 'stale' });

    const held = await seedPromise();
    const h = ports({ phone: async () => null });
    await runAckDeadlineSweep(db.database, h.ports, AFTER_DUE);
    expect(await promiseRow(held.promiseId)).toMatchObject({ outcome: 'held' });

    expect(p.transport.sent).toEqual([]);
    expect(h.transport.sent).toEqual([]);
    expect(h.facts).toEqual([]);
  });
  it('sends nothing when the answer lands while the note is being written', async () => {
    const seeded = await seedPromise();
    const p = ports();
    const lateNote = p.ports.writer.lateNote;
    p.ports.writer = {
      ...p.ports.writer,
      lateNote: async (facts) => {
        await auditTurnLedger(db.database).recordAnswered({
          familyId: seeded.familyId,
          parentUserId: seeded.parentUserId,
          channelMessageId: seeded.inboundId,
          folded: [],
        });
        return lateNote(facts);
      },
    };

    const summary = await runAckDeadlineSweep(db.database, p.ports, AFTER_DUE);

    // The writer ran, so it is the read after it that stopped the send.
    expect(p.facts).toHaveLength(1);
    expect(summary.settled).toEqual({ answered: 1 });
    expect(p.transport.sent).toEqual([]);
    const audits = await deadlineAudits(seeded.promiseId);
    expect(audits.map((a) => a.after)).toContainEqual({
      outcome: 'answered',
      reason: 'while_writing',
    });
  });

  describe('a turn that closed with its answered row missing', () => {
    async function outbound(
      seeded: { familyId: string; parentUserId: string },
      templateKey: string | null,
      status: 'sent' | 'failed' = 'sent',
    ) {
      await db.database.insert(schema.channelMessages).values({
        familyId: seeded.familyId,
        parentUserId: seeded.parentUserId,
        channel: 'sms',
        direction: 'out',
        category: 'reply',
        status,
        templateKey,
      });
    }

    it('a reply Linq took is an answer: no note says nothing more is coming', async () => {
      const seeded = await seedPromise('sms');
      // The real order: the turn writes its reply's receipt, then done() closes it.
      await outbound(seeded, null);
      await auditTurnLedger(db.database).recordRouted({ channelMessageId: seeded.inboundId });
      const p = ports();

      const summary = await runAckDeadlineSweep(db.database, p.ports, AFTER_DUE);

      expect(summary.settled).toEqual({ answered: 1 });
      expect(p.facts).toEqual([]);
      expect(p.transport.sent).toEqual([]);
      expect(await promiseRow(seeded.promiseId)).toMatchObject({ outcome: 'answered' });
    });

    it.each([
      ['the ack itself', 'ack_eta', 'sent'],
      ['a holding tapback', 'holding_line', 'sent'],
      ["another text's side reply", 'side_turn', 'sent'],
      ['a send the provider refused', null, 'failed'],
    ] as const)('%s is not an answer: the note still goes', async (_label, key, status) => {
      const seeded = await seedPromise('sms');
      await outbound(seeded, key, status);
      await auditTurnLedger(db.database).recordRouted({ channelMessageId: seeded.inboundId });
      const p = ports();

      await runAckDeadlineSweep(db.database, p.ports, AFTER_DUE);

      expect(p.facts.map((f) => f.status)).toEqual(['stopped']);
      expect(p.transport.bodies()).toEqual(['a stand-in late note']);
    });

    it('a nudge written after the turn closed is not the answer: the note still goes', async () => {
      const seeded = await seedPromise('sms');
      await auditTurnLedger(db.database).recordRouted({ channelMessageId: seeded.inboundId });
      const [close] = await db.database
        .select({ claimedAt: schema.channelTurnAnswerClaims.claimedAt })
        .from(schema.channelTurnAnswerClaims)
        .where(eq(schema.channelTurnAnswerClaims.channelMessageId, seeded.inboundId));
      if (!close) throw new Error('seed: the routed claim did not land');
      // The nudge sweep's own row: category reply, its own key, a minute after the close.
      await db.database.insert(schema.channelMessages).values({
        familyId: seeded.familyId,
        parentUserId: seeded.parentUserId,
        channel: 'sms',
        direction: 'out',
        category: 'reply',
        status: 'sent',
        templateKey: 'followup:activity',
        createdAt: new Date(close.claimedAt.getTime() + 60_000),
      });
      const p = ports();

      const summary = await runAckDeadlineSweep(db.database, p.ports, AFTER_DUE);

      expect(summary.settled).toEqual({ sent: 1 });
      expect(p.facts.map((f) => f.status)).toEqual(['stopped']);
      expect(p.transport.bodies()).toEqual(['a stand-in late note']);
    });

    it('a turn whose failure row says nothing went stays unanswered, whatever else went out', async () => {
      const seeded = await seedPromise('sms');
      // A nudge inside the turn's own window, so only the failure row can tell them apart.
      await outbound(seeded, 'followup:activity');
      const turns = auditTurnLedger(db.database);
      await turns.recordFailed({
        familyId: seeded.familyId,
        parentUserId: seeded.parentUserId,
        channelMessageId: seeded.inboundId,
        reason: 'notice_unsent',
      });
      await turns.recordRouted({ channelMessageId: seeded.inboundId });
      const p = ports();

      const summary = await runAckDeadlineSweep(db.database, p.ports, AFTER_DUE);

      expect(summary.settled).toEqual({ sent: 1 });
      expect(p.facts.map((f) => f.status)).toEqual(['stopped']);
    });
  });

  it('two overlapping ticks claim a due promise once and send one note', async () => {
    const seeded = await seedPromise();
    const p = ports();
    // Both ticks have read the row before either claims it, whatever order the queries run.
    let arrived = 0;
    let release: () => void = () => {};
    const bothPlanned = new Promise<void>((resolve) => {
      release = resolve;
    });
    p.ports.quietUntil = async () => {
      arrived += 1;
      if (arrived === 2) release();
      await bothPlanned;
      return null;
    };

    const ticks = await Promise.all([
      runAckDeadlineSweep(db.database, p.ports, AFTER_DUE),
      runAckDeadlineSweep(db.database, p.ports, AFTER_DUE),
    ]);

    expect(ticks.map((tick) => tick.due)).toEqual([1, 1]);
    expect(ticks.map((tick) => tick.claimed).sort()).toEqual([0, 1]);
    expect(p.transport.sent.map((sent) => sent.sendKey)).toEqual([
      `ack_eta_late_note:${seeded.promiseId}`,
    ]);
    const audits = await deadlineAudits(seeded.promiseId);
    expect(audits.filter((a) => (a.after as { outcome?: string }).outcome === 'sent')).toHaveLength(
      1,
    );
  });

  describe('through the outbound gate, on the production wiring', () => {
    const PHONE = '+15550000000';
    const SENDING_LINE = '+15555550199';
    const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

    beforeEach(() => {
      vi.stubEnv('APP_ENCRYPTION_KEY', ENCRYPTION_KEY);
      vi.stubEnv('ACK_ETA_ENABLED', 'true');
      vi.stubEnv('F14_ENABLED', 'true');
      vi.stubEnv('LINQ_FROM_E164', SENDING_LINE);
    });

    afterEach(async () => {
      vi.unstubAllEnvs();
      await db.database.delete(schema.optOutHeldMessages);
      await db.database.delete(schema.linqLineHealth);
    });

    async function enroll(seeded: { familyId: string; parentUserId: string }) {
      // A real zone, so the note's daytime is the same with FAMILY_TZ_RESOLVE_ENABLED on or off.
      await db.database
        .update(schema.users)
        .set({ timezone: 'America/Toronto' })
        .where(eq(schema.users.id, seeded.parentUserId));
      await db.database.insert(schema.parentChannels).values({
        userId: seeded.parentUserId,
        familyId: seeded.familyId,
        kind: 'sms',
        phoneE164Encrypted: encryptString(PHONE),
        phoneE164Hash: phoneBlindIndex(PHONE),
        verifiedAt: ASKED_AT,
      });
    }

    async function answerWatch(
      seeded: { familyId: string; parentUserId: string },
      granted: boolean,
    ) {
      await db.database.insert(schema.consentRecords).values({
        userId: seeded.parentUserId,
        familyId: seeded.familyId,
        consentType: 'proactive_watch',
        consentScope: WATCH_CONSENT_SCOPE,
        granted,
        policyVersion: POLICY_VERSION,
        evidence: { verbatimReply: granted ? 'an invented yes' : 'an invented no' },
      });
    }

    function wired(lateNote?: AckLineWriter['lateNote']) {
      const transport = new FakeTransport();
      const built: AckDeadlinePorts = {
        ...ackDeadlinePorts(db.database),
        writer: {
          ack: async () => ({ status: 'unavailable', reason: 'client_unavailable' }),
          lateNote: lateNote ?? (async () => ({ status: 'composed', line: 'a stand-in note' })),
        },
        transport,
        page: async () => 'paged',
        thread: async () => undefined,
        log: { info: () => {}, warn: () => {}, error: () => {} },
      };
      return { ports: built, transport };
    }

    it('a paused sending line holds the note unclaimed, and it goes when the line clears', async () => {
      const seeded = await seedPromise('sms');
      await enroll(seeded);
      await answerWatch(seeded, true);
      await db.database
        .insert(schema.linqLineHealth)
        .values({ phoneNumber: SENDING_LINE, status: 'flagged', paused: true });
      const p = wired();

      const held = await runAckDeadlineSweep(db.database, p.ports, AFTER_DUE);

      expect(held).toMatchObject({ claimed: 0, railHeld: 1, settled: {} });
      expect(p.transport.sent).toEqual([]);
      expect(await promiseRow(seeded.promiseId)).toMatchObject({
        claimedAt: null,
        outcome: null,
      });

      await db.database.update(schema.linqLineHealth).set({ paused: false });
      const cleared = await runAckDeadlineSweep(
        db.database,
        p.ports,
        new Date(AFTER_DUE.getTime() + 60_000),
      );

      expect(cleared.settled).toEqual({ sent: 1 });
      expect(p.transport.bodies()).toEqual(['a stand-in note']);
    });

    it('a parent who declined the watch gets no note, and the refusal is named', async () => {
      const seeded = await seedPromise('sms');
      await enroll(seeded);
      await answerWatch(seeded, false);
      const p = wired();

      const summary = await runAckDeadlineSweep(db.database, p.ports, AFTER_DUE);

      expect(summary.settled).toEqual({ held: 1 });
      expect(p.transport.sent).toEqual([]);
      const audits = await deadlineAudits(seeded.promiseId);
      expect(audits.map((a) => a.after)).toContainEqual({
        outcome: 'held',
        reason: 'no_watch_consent',
      });
    });

    it('a parent with no live channel gets no note, and the refusal is named', async () => {
      const seeded = await seedPromise('sms');
      await answerWatch(seeded, true);
      const p = wired();

      const summary = await runAckDeadlineSweep(db.database, p.ports, AFTER_DUE);

      expect(summary.settled).toEqual({ held: 1 });
      expect(p.transport.sent).toEqual([]);
      const audits = await deadlineAudits(seeded.promiseId);
      expect(audits.map((a) => a.after)).toContainEqual({
        outcome: 'held',
        reason: 'not_enrolled',
      });
    });

    it('a parent who said yes to the watch gets it (the control)', async () => {
      const seeded = await seedPromise('sms');
      await enroll(seeded);
      await answerWatch(seeded, true);
      const p = wired();

      const summary = await runAckDeadlineSweep(db.database, p.ports, AFTER_DUE);

      expect(summary.settled).toEqual({ sent: 1 });
      expect(p.transport.bodies()).toEqual(['a stand-in note']);
    });

    it('with F14 dark for the family there is no note, and that is named', async () => {
      vi.stubEnv('F14_ENABLED', 'false');
      const seeded = await seedPromise('sms');
      await enroll(seeded);
      await answerWatch(seeded, true);
      const p = wired();

      const summary = await runAckDeadlineSweep(db.database, p.ports, AFTER_DUE);

      expect(summary.settled).toEqual({ lane_off: 1 });
      expect(p.transport.sent).toEqual([]);
      const audits = await deadlineAudits(seeded.promiseId);
      expect(audits.map((a) => a.after)).toContainEqual({
        outcome: 'lane_off',
        reason: 'f14_dark',
      });
    });

    it('with F14 off, a family on its allowlist still gets the note', async () => {
      vi.stubEnv('F14_ENABLED', 'false');
      const seeded = await seedPromise('sms');
      vi.stubEnv('F14_FAMILY_ALLOWLIST', seeded.familyId);
      await enroll(seeded);
      await answerWatch(seeded, true);
      const p = wired();

      const summary = await runAckDeadlineSweep(db.database, p.ports, AFTER_DUE);

      expect(summary.settled).toEqual({ sent: 1 });
    });

    it('during an operator pause the note stays owed, and goes when the pause lifts', async () => {
      const seeded = await seedPromise('sms');
      await enroll(seeded);
      await answerWatch(seeded, true);
      const p = wired();
      vi.stubEnv('PROACTIVE_SENDS_PAUSED', 'true');

      const paused = await runAckDeadlineSweep(db.database, p.ports, AFTER_DUE);

      expect(paused).toMatchObject({ due: 1, claimed: 0, railHeld: 1, settled: {} });
      expect(p.transport.sent).toEqual([]);
      expect((await promiseRow(seeded.promiseId))?.claimedAt).toBeNull();

      vi.stubEnv('PROACTIVE_SENDS_PAUSED', 'false');
      const lifted = await runAckDeadlineSweep(
        db.database,
        p.ports,
        new Date(AFTER_DUE.getTime() + 60_000),
      );

      expect(lifted.settled).toEqual({ sent: 1 });
      expect(p.transport.bodies()).toEqual(['a stand-in note']);
    });

    it('an unread opt-out holds the note unclaimed until the read succeeds', async () => {
      const seeded = await seedPromise('sms');
      await enroll(seeded);
      await answerWatch(seeded, true);
      await holdSender(db.database, {
        phoneHash: phoneBlindIndex(PHONE),
        providerMessageId: 'an-invented-held-text',
        now: AFTER_DUE,
      });
      const p = wired();

      const held = await runAckDeadlineSweep(db.database, p.ports, AFTER_DUE);

      expect(held).toMatchObject({ claimed: 0, railHeld: 1, settled: {} });
      expect(p.transport.sent).toEqual([]);
      expect((await promiseRow(seeded.promiseId))?.claimedAt).toBeNull();

      await db.database.delete(schema.optOutHeldMessages);
      const read = await runAckDeadlineSweep(
        db.database,
        p.ports,
        new Date(AFTER_DUE.getTime() + 60_000),
      );

      expect(read.settled).toEqual({ sent: 1 });
    });

    it('a hold that outlasts the stale window ends as stale, and nothing goes', async () => {
      const seeded = await seedPromise('sms');
      await enroll(seeded);
      await answerWatch(seeded, true);
      vi.stubEnv('PROACTIVE_SENDS_PAUSED', 'true');
      const p = wired();
      await runAckDeadlineSweep(db.database, p.ports, AFTER_DUE);

      const late = await runAckDeadlineSweep(
        db.database,
        p.ports,
        new Date(DUE_AT.getTime() + ACK_LATE_NOTE_STALE_MS + 1_000),
      );

      expect(late.settled).toEqual({ stale: 1 });
      expect(p.transport.sent).toEqual([]);
      expect(await promiseRow(seeded.promiseId)).toMatchObject({ outcome: 'stale' });
    });

    it('a parent who leaves the channel while the note is written is not texted', async () => {
      const seeded = await seedPromise('sms');
      await enroll(seeded);
      await answerWatch(seeded, true);
      const p = wired(async () => {
        await db.database
          .update(schema.parentChannels)
          .set({ revokedAt: new Date() })
          .where(eq(schema.parentChannels.userId, seeded.parentUserId));
        return { status: 'composed', line: 'a stand-in note' };
      });

      const summary = await runAckDeadlineSweep(db.database, p.ports, AFTER_DUE);

      expect(summary.settled).toEqual({ held: 1 });
      expect(p.transport.sent).toEqual([]);
      const audits = await deadlineAudits(seeded.promiseId);
      expect(audits.map((a) => a.after)).toContainEqual({
        outcome: 'held',
        reason: 'not_enrolled',
      });
    });
  });

  describe("the note's audit row is one adult's", () => {
    const NOTE = 'Hale told you an answer was taking longer than it said';
    const ANSWERED = 'Hale came back to you about an activity search';
    const PROMISED = 'Hale told you when to expect an answer';
    const CHECKED = 'Hale checked whether an answer it promised went out in time';

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    async function twoParentsAndANote() {
      const seeded = await seedPromise('sms');
      const [co] = await db.database
        .insert(schema.users)
        .values({ email: `${seeded.familyId}-co@example.test`, name: 'Co Parent' })
        .returning({ id: schema.users.id });
      const coParent = co?.id as string;
      await db.database
        .insert(schema.familyMembers)
        .values({ familyId: seeded.familyId, userId: coParent, role: 'co_parent' });
      await recordLateNote(db.database, {
        promise: {
          id: seeded.promiseId,
          familyId: seeded.familyId,
          parentUserId: seeded.parentUserId,
        },
        sent: { providerMessageId: 'an-invented-id', channel: 'sms', chatId: null },
        now: AFTER_DUE,
      });
      // A family-visible row, so a History that shows nothing cannot pass the negatives.
      await db.database.insert(schema.auditLog).values({
        familyId: seeded.familyId,
        actor: 'system',
        actionTaken: 'activity_followup_sent',
        targetTable: 'agent_commitments',
        targetId: seeded.promiseId,
      });
      const history = async (viewerUserId: string) =>
        (await loadTrailForFamily(db.database, seeded.familyId, undefined, { viewerUserId })).map(
          (row) => row.summary,
        );
      const copy = async (actorUserId: string) =>
        (
          await assembleFamilyExport(db.database, seeded.familyId, { actorUserId, now: AFTER_DUE })
        ).trail.map((row) => row.summary);
      return {
        asker: seeded.parentUserId,
        coParent,
        history,
        copy,
        promise: {
          id: seeded.promiseId,
          familyId: seeded.familyId,
          parentUserId: seeded.parentUserId,
        },
      };
    }

    it('audience read off: not in anyone’s History, in the asker’s own access copy only', async () => {
      const { asker, coParent, history, copy } = await twoParentsAndANote();

      expect(await history(coParent)).toContain(ANSWERED);
      expect(await history(coParent)).not.toContain(NOTE);
      expect(await history(asker)).not.toContain(NOTE);
      expect(await copy(asker)).toEqual(expect.arrayContaining([NOTE, ANSWERED]));
      const coParentCopy = await copy(coParent);
      expect(coParentCopy).toContain(ANSWERED);
      expect(coParentCopy).not.toContain(NOTE);
    });

    it('audience read off: the promise and its ending are in the asker’s copy only', async () => {
      const { asker, coParent, copy, promise } = await twoParentsAndANote();
      await settleAckPromise(db.database, { promise, outcome: 'sent', now: AFTER_DUE });

      expect(await copy(asker)).toEqual(expect.arrayContaining([PROMISED, CHECKED, ANSWERED]));
      const coParentCopy = await copy(coParent);
      expect(coParentCopy).toContain(ANSWERED);
      expect(coParentCopy).not.toContain(PROMISED);
      expect(coParentCopy).not.toContain(CHECKED);
    });

    it('audience read on: in the asker’s History and copy, never the other adult’s', async () => {
      vi.stubEnv(AUDIT_LOG_AUDIENCE_ENABLED_ENV, 'true');
      const { asker, coParent, history, copy } = await twoParentsAndANote();

      expect(await history(asker)).toEqual(expect.arrayContaining([NOTE, ANSWERED]));
      expect(await history(coParent)).toContain(ANSWERED);
      expect(await history(coParent)).not.toContain(NOTE);
      expect(await copy(asker)).toEqual(expect.arrayContaining([NOTE, ANSWERED]));
      expect(await copy(coParent)).not.toContain(NOTE);
    });
  });

  describe('quiet hours on the parent’s clock', () => {
    const TORONTO = 'America/Toronto';
    const quietUntil = async (_parentUserId: string, at: Date) =>
      inProactiveQuietHours(at, TORONTO) ? proactiveFloorOpensAt(at, TORONTO) : null;
    // 23:20 and 23:20:20 in Toronto (UTC-5 in November), so due at 23:25:20.
    const NIGHT_ASK = new Date('2025-11-21T04:20:00.000Z');
    const NIGHT_ACK = new Date('2025-11-21T04:20:20.000Z');
    const NIGHT_TICK = new Date('2025-11-21T04:31:00.000Z');
    const MORNING = new Date('2025-11-21T13:00:00.000Z');
    const MORNING_TICK = new Date('2025-11-21T13:00:30.000Z');

    it('production reads the floor from the parent’s own stored zone', async () => {
      const { parentUserId } = await seedFamily(db.database);
      await db.database
        .update(schema.users)
        .set({ timezone: TORONTO })
        .where(eq(schema.users.id, parentUserId));
      const wired = ackDeadlinePorts(db.database);

      await expect(wired.quietUntil(parentUserId, NIGHT_TICK)).resolves.toEqual(MORNING);
      // 12:00 in Toronto.
      await expect(
        wired.quietUntil(parentUserId, new Date('2025-11-21T17:00:00.000Z')),
      ).resolves.toBeNull();
    });

    it('holds a note owed at 23:31, unclaimed, and sends nothing until 08:00', async () => {
      const seeded = await seedPromise('sms', { askedAt: NIGHT_ASK, ackAt: NIGHT_ACK });
      const p = ports({ quietUntil });

      const night = await runAckDeadlineSweep(db.database, p.ports, NIGHT_TICK);

      expect(night).toMatchObject({ due: 1, claimed: 0, quietHeld: 1, settled: {} });
      expect(p.facts).toEqual([]);
      expect(p.transport.sent).toEqual([]);
      const held = await promiseRow(seeded.promiseId);
      expect(held?.claimedAt).toBeNull();
      expect(held?.settledAt).toBeNull();
      expect(held?.heldUntil).toEqual(MORNING);

      // Not read again through the night: a row held till morning is not due.
      const dawn = await runAckDeadlineSweep(
        db.database,
        p.ports,
        new Date(MORNING.getTime() - 60_000),
      );
      expect(dawn).toMatchObject({ due: 0, claimed: 0, quietHeld: 0 });
      expect(p.transport.sent).toEqual([]);
    });

    it('the first tick after 08:00 sends it, and a text past the retry ceiling is told it stopped', async () => {
      const seeded = await seedPromise('sms', { askedAt: NIGHT_ASK, ackAt: NIGHT_ACK });
      const p = ports({ quietUntil });
      await runAckDeadlineSweep(db.database, p.ports, NIGHT_TICK);
      // The ceiling has passed: the queue gave up on this text during the night.
      expect(MORNING_TICK.getTime()).toBeGreaterThan(NIGHT_ASK.getTime() + retryCeilingMs());

      const morning = await runAckDeadlineSweep(db.database, p.ports, MORNING_TICK);

      expect(morning.settled).toEqual({ sent: 1 });
      expect(p.facts.map((f) => [f.status, f.newWithinMinutes])).toEqual([['stopped', null]]);
      expect(p.transport.bodies()).toEqual(['a stand-in late note']);
      expect(await promiseRow(seeded.promiseId)).toMatchObject({ outcome: 'sent' });
    });

    it('a text still inside the retry ceiling at 08:00 says Hale is still on it', async () => {
      // 07:50 in Toronto: due at 07:55:20, inside the night, and the queue is still trying.
      const askedAt = new Date('2025-11-21T12:50:00.000Z');
      const ackAt = new Date('2025-11-21T12:50:20.000Z');
      await seedPromise('sms', { askedAt, ackAt });
      const p = ports({ quietUntil });

      const held = await runAckDeadlineSweep(
        db.database,
        p.ports,
        new Date('2025-11-21T12:56:00.000Z'),
      );
      expect(held).toMatchObject({ claimed: 0, quietHeld: 1 });

      await runAckDeadlineSweep(db.database, p.ports, MORNING_TICK);

      expect(p.facts.map((f) => f.status)).toEqual(['still_working']);
      expect(p.facts[0]?.newWithinMinutes ?? 0).toBeGreaterThan(PROMISED_MINUTES);
    });

    it('a promise already answered settles at night: nothing to wait for, nothing sent', async () => {
      const seeded = await seedPromise('sms', { askedAt: NIGHT_ASK, ackAt: NIGHT_ACK });
      await auditTurnLedger(db.database).recordAnswered({
        familyId: seeded.familyId,
        parentUserId: seeded.parentUserId,
        channelMessageId: seeded.inboundId,
        folded: [],
      });
      const p = ports({ quietUntil });

      const night = await runAckDeadlineSweep(db.database, p.ports, NIGHT_TICK);

      expect(night).toMatchObject({ claimed: 1, quietHeld: 0, settled: { answered: 1 } });
      expect(p.transport.sent).toEqual([]);
      expect(await promiseRow(seeded.promiseId)).toMatchObject({
        outcome: 'answered',
        heldUntil: null,
      });
    });

    it('the stale clock restarts at 08:00, and a tick that misses that window drops it', async () => {
      const kept = await seedPromise('sms', { askedAt: NIGHT_ASK, ackAt: NIGHT_ACK });
      const p = ports({ quietUntil });
      await runAckDeadlineSweep(db.database, p.ports, NIGHT_TICK);

      const late = await runAckDeadlineSweep(
        db.database,
        p.ports,
        new Date(MORNING.getTime() + ACK_LATE_NOTE_STALE_MS + 1_000),
      );

      expect(late.settled).toEqual({ stale: 1 });
      expect(p.transport.sent).toEqual([]);
      expect(await promiseRow(kept.promiseId)).toMatchObject({ outcome: 'stale' });
    });

    it('a note that could not land before 21:00 waits for morning; one that can, goes', async () => {
      // 20:50 in Toronto, due at 20:55:20.
      const askedAt = new Date('2025-11-21T01:50:00.000Z');
      const ackAt = new Date('2025-11-21T01:50:20.000Z');
      const eightAm = new Date('2025-11-21T13:00:00.000Z');
      const tooLate = await seedPromise('sms', { askedAt, ackAt });
      const p = ports({ quietUntil });

      // Inside the write headroom of 21:00.
      const close = new Date(
        new Date('2025-11-21T02:00:00.000Z').getTime() - ACK_NOTE_WRITE_HEADROOM_MS + 1_000,
      );
      const held = await runAckDeadlineSweep(db.database, p.ports, close);

      expect(held).toMatchObject({ claimed: 0, quietHeld: 1 });
      expect(p.transport.sent).toEqual([]);
      expect((await promiseRow(tooLate.promiseId))?.heldUntil).toEqual(eightAm);

      // The control: the same evening, clear of the headroom.
      await db.exec('truncate table families, users cascade');
      await seedPromise('sms', { askedAt, ackAt });
      const clear = ports({ quietUntil });
      const early = new Date(
        new Date('2025-11-21T02:00:00.000Z').getTime() - ACK_NOTE_WRITE_HEADROOM_MS - 1_000,
      );
      const sent = await runAckDeadlineSweep(db.database, clear.ports, early);
      expect(sent).toMatchObject({ claimed: 1, quietHeld: 0, settled: { sent: 1 } });
      expect(clear.transport.bodies()).toEqual(['a stand-in late note']);
    });

    it('rows held for the night never crowd out a parent whose day it is', async () => {
      const nightParents = new Set<string>();
      for (let i = 0; i < ACK_SWEEP_BATCH; i += 1) {
        const seeded = await seedPromise('sms', {
          askedAt: NIGHT_ASK,
          ackAt: new Date(NIGHT_ACK.getTime() + i * 1_000),
        });
        nightParents.add(seeded.parentUserId);
      }
      const daytime = await seedPromise('sms', {
        askedAt: NIGHT_ASK,
        ackAt: new Date(NIGHT_ACK.getTime() + ACK_SWEEP_BATCH * 1_000),
      });
      const p = ports({
        quietUntil: async (parentUserId, at) =>
          nightParents.has(parentUserId) ? proactiveFloorOpensAt(at, TORONTO) : null,
      });

      await runAckDeadlineSweep(db.database, p.ports, NIGHT_TICK);
      await runAckDeadlineSweep(db.database, p.ports, new Date(NIGHT_TICK.getTime() + 60_000));

      expect(p.transport.sent.map((s) => s.sendKey)).toEqual([
        `ack_eta_late_note:${daytime.promiseId}`,
      ]);
    });
  });
});

describe('VIL-717 · a late note the send did not confirm', () => {
  const NEXT_TICK = new Date(AFTER_DUE.getTime() + 60_000);

  /** A Linq door that refuses as scripted, then takes the note. Records each attempt's key. */
  function flakyTransport(refusals: unknown[]) {
    const left = [...refusals];
    const keys: Array<string | undefined> = [];
    const taken: string[] = [];
    const transport: ChannelTransport = {
      async send({ body, sendKey }) {
        keys.push(sendKey);
        const refusal = left.shift();
        if (refusal) throw refusal;
        taken.push(body);
        return { providerMessageId: 'an-invented-id' };
      },
    };
    return { transport, keys, taken };
  }

  it.each([
    ['a rate limit', () => new LinqSendError('rate_limited', 429, false)],
    ['a timeout that may have landed', () => new LinqSendError('timeout', 0, false)],
    ['a 5xx', () => new LinqSendError('server_error', 503, false)],
    ['a permanent 409 that may have landed', () => new LinqSendError('conflict', 409, true)],
    ['a door not configured yet', () => new LinqSendError('not_configured', 0, true)],
  ])('%s: releases the claim, and the next tick sends under the same key', async (_name, make) => {
    const seeded = await seedPromise('sms');
    const door = flakyTransport([make()]);
    const p = ports({ transport: door.transport });

    const first = await runAckDeadlineSweep(db.database, p.ports, AFTER_DUE);

    expect(first.settled).toEqual({});
    expect(await promiseRow(seeded.promiseId)).toMatchObject({
      claimedAt: null,
      settledAt: null,
      outcome: null,
    });
    expect(p.pages).toEqual([]);

    const second = await runAckDeadlineSweep(db.database, p.ports, NEXT_TICK);

    expect(second.settled).toEqual({ sent: 1 });
    expect(door.taken).toEqual(['a stand-in late note']);
    const key = `ack_eta_late_note:${seeded.promiseId}`;
    expect(door.keys).toEqual([key, key]);
    expect(await promiseRow(seeded.promiseId)).toMatchObject({ outcome: 'sent' });
  });

  it('a certain refusal settles send_failed, pages #ops, and no tick tries again', async () => {
    const seeded = await seedPromise('sms');
    const door = flakyTransport([new LinqSendError('1005', 422, true)]);
    const p = ports({ transport: door.transport });

    const first = await runAckDeadlineSweep(db.database, p.ports, AFTER_DUE);
    const second = await runAckDeadlineSweep(db.database, p.ports, NEXT_TICK);

    expect(first.settled).toEqual({ send_failed: 1 });
    expect(second).toMatchObject({ due: 0, claimed: 0 });
    expect(door.keys).toHaveLength(1);
    expect(p.pages).toEqual([{ stage: 'late_note', reason: 'send_refused' }]);
    expect(await promiseRow(seeded.promiseId)).toMatchObject({ outcome: 'send_failed' });
  });

  it('a read that throws after the claim releases it, because nothing went', async () => {
    const seeded = await seedPromise('sms');
    let reads = 0;
    const p = ports({
      phone: async () => {
        reads += 1;
        if (reads === 1) throw new Error('connection reset');
        return '+15550000000';
      },
    });

    const first = await runAckDeadlineSweep(db.database, p.ports, AFTER_DUE);

    expect(first.settled).toEqual({});
    expect(p.transport.sent).toEqual([]);
    expect(await promiseRow(seeded.promiseId)).toMatchObject({ claimedAt: null, outcome: null });

    const second = await runAckDeadlineSweep(db.database, p.ports, NEXT_TICK);

    expect(second.settled).toEqual({ sent: 1 });
    expect(p.transport.bodies()).toEqual(['a stand-in late note']);
  });

  it('a send that never confirms ends stale, named, and #ops is told the note was dropped', async () => {
    const seeded = await seedPromise('sms');
    const door = flakyTransport([
      new LinqSendError('timeout', 0, false),
      new LinqSendError('timeout', 0, false),
    ]);
    const p = ports({ transport: door.transport });

    await runAckDeadlineSweep(db.database, p.ports, AFTER_DUE);
    await runAckDeadlineSweep(db.database, p.ports, NEXT_TICK);
    const last = await runAckDeadlineSweep(
      db.database,
      p.ports,
      new Date(DUE_AT.getTime() + ACK_LATE_NOTE_STALE_MS + 1_000),
    );

    expect(last.settled).toEqual({ stale: 1 });
    expect(door.keys).toHaveLength(2);
    expect(door.taken).toEqual([]);
    expect(p.pages).toEqual([{ stage: 'late_note', reason: 'send_unconfirmed' }]);
    const audits = await deadlineAudits(seeded.promiseId);
    expect(audits.at(-1)?.after).toEqual({ outcome: 'stale', reason: 'send_unconfirmed' });
  });

  it('an answered text that went stale is not a dropped note: no page', async () => {
    const seeded = await seedPromise('sms');
    await auditTurnLedger(db.database).recordAnswered({
      familyId: seeded.familyId,
      parentUserId: seeded.parentUserId,
      channelMessageId: seeded.inboundId,
      folded: [],
    });
    const p = ports();

    await runAckDeadlineSweep(
      db.database,
      p.ports,
      new Date(DUE_AT.getTime() + ACK_LATE_NOTE_STALE_MS + 1_000),
    );

    expect(p.pages).toEqual([]);
    expect(await promiseRow(seeded.promiseId)).toMatchObject({ outcome: 'stale' });
  });
});

describe('VIL-717 · the line-health pause', () => {
  it('held at the send: the row goes back unclaimed and nothing is sent', async () => {
    const seeded = await seedPromise('sms');
    const answers: Array<'line_health' | null> = [null, 'line_health'];
    const p = ports({ lineHold: async () => answers.shift() ?? null });

    const first = await runAckDeadlineSweep(db.database, p.ports, AFTER_DUE);

    expect(first.settled).toEqual({});
    expect(p.transport.sent).toEqual([]);
    expect(await promiseRow(seeded.promiseId)).toMatchObject({ claimedAt: null, outcome: null });

    const second = await runAckDeadlineSweep(
      db.database,
      p.ports,
      new Date(AFTER_DUE.getTime() + 60_000),
    );

    expect(second.settled).toEqual({ sent: 1 });
    expect(p.transport.bodies()).toEqual(['a stand-in late note']);
  });

  it('still held when the note goes stale: dropped, with the hold named', async () => {
    const seeded = await seedPromise('sms');
    const p = ports({ lineHold: async () => 'line_health' });

    const held = await runAckDeadlineSweep(db.database, p.ports, AFTER_DUE);
    const last = await runAckDeadlineSweep(
      db.database,
      p.ports,
      new Date(DUE_AT.getTime() + ACK_LATE_NOTE_STALE_MS + 1_000),
    );

    expect(held).toMatchObject({ claimed: 0, railHeld: 1 });
    expect(last.settled).toEqual({ stale: 1 });
    expect(p.transport.sent).toEqual([]);
    expect(p.pages).toEqual([{ stage: 'late_note', reason: 'line_held' }]);
    const audits = await deadlineAudits(seeded.promiseId);
    expect(audits.at(-1)?.after).toEqual({ outcome: 'stale', reason: 'line_health' });
  });
});

describe('VIL-717 · a family that asked to be erased', () => {
  async function scheduleErasure(familyId: string) {
    await db.database
      .update(schema.families)
      .set({ scheduledDeletionAt: new Date(AFTER_DUE.getTime() + 7 * 24 * 60 * 60_000) })
      .where(eq(schema.families.id, familyId));
  }

  it('settles held, named, before anything is written', async () => {
    const seeded = await seedPromise('sms');
    const control = await seedPromise('sms');
    await scheduleErasure(seeded.familyId);
    const p = ports();

    const summary = await runAckDeadlineSweep(db.database, p.ports, AFTER_DUE);

    expect(summary.settled).toEqual({ held: 1, sent: 1 });
    expect(p.transport.sent.map((s) => s.sendKey)).toEqual([
      `ack_eta_late_note:${control.promiseId}`,
    ]);
    expect(p.facts).toHaveLength(1);
    expect(await promiseRow(seeded.promiseId)).toMatchObject({ outcome: 'held' });
    const audits = await deadlineAudits(seeded.promiseId);
    expect(audits.at(-1)?.after).toEqual({ outcome: 'held', reason: 'erasure_scheduled' });
  });

  it('asked while the note was being written: nothing goes', async () => {
    const seeded = await seedPromise('sms');
    const base = ports();
    const p = ports({
      writer: {
        ...base.ports.writer,
        lateNote: async () => {
          await scheduleErasure(seeded.familyId);
          return { status: 'composed', line: 'a stand-in late note' };
        },
      },
    });

    const summary = await runAckDeadlineSweep(db.database, p.ports, AFTER_DUE);

    expect(summary.settled).toEqual({ held: 1 });
    expect(p.transport.sent).toEqual([]);
    const audits = await deadlineAudits(seeded.promiseId);
    expect(audits.at(-1)?.after).toEqual({ outcome: 'held', reason: 'erasure_scheduled' });
  });
});
