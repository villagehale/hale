import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { inProactiveQuietHours, proactiveFloorOpensAt } from '~/lib/channel/outbound-gate';
import { FakeReplyTransport } from '~/lib/channel/router/reply-route';
import { auditTurnLedger } from '~/lib/channel/router/wiring';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import type { AckCompose, LateNoteFacts } from './compose';
import { ackDeadlinePorts } from './production';
import { recordAckPromise } from './promise';
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
  const transport = new FakeReplyTransport();
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
    quietUntil: async () => null,
    rail: async () => 'clear',
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

async function deadlineAudits(promiseId: string) {
  return db.database
    .select({ after: schema.auditLog.after, audience: schema.auditLog.audience })
    .from(schema.auditLog)
    .where(eq(schema.auditLog.targetId, promiseId));
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
        route: {
          channel: 'imessage',
          to: '+15550000000',
          chatId: 'chat-one',
          replyToMessageId: 'parent-msg-1',
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
    expect(p.transport.sent.map((s) => s.route)).toEqual([{ channel: 'sms', to: '+15550000000' }]);
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
  it.each(['sends_paused', 'opt_out_unread'] as const)(
    'holds the note on %s: nothing is written or sent, and the reason is on the audit row',
    async (rail) => {
      const seeded = await seedPromise();
      const p = ports({ rail: async () => rail });

      const summary = await runAckDeadlineSweep(db.database, p.ports, AFTER_DUE);

      expect(summary.settled).toEqual({ held: 1 });
      expect(p.facts).toEqual([]);
      expect(p.transport.sent).toEqual([]);
      expect(await promiseRow(seeded.promiseId)).toMatchObject({ outcome: 'held' });
      const audits = await deadlineAudits(seeded.promiseId);
      expect(audits.map((a) => a.after)).toContainEqual({ outcome: 'held', reason: rail });
    },
  );

  it('a clear rail lets the same note go (the control for the holds above)', async () => {
    const seeded = await seedPromise();
    const p = ports({ rail: async () => 'clear' });

    const summary = await runAckDeadlineSweep(db.database, p.ports, AFTER_DUE);

    expect(summary.settled).toEqual({ sent: 1 });
    expect(p.transport.bodies()).toEqual(['a stand-in late note']);
    expect(await promiseRow(seeded.promiseId)).toMatchObject({ outcome: 'sent' });
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
      await auditTurnLedger(db.database).recordRouted({ channelMessageId: seeded.inboundId });
      await outbound(seeded, null);
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
      await auditTurnLedger(db.database).recordRouted({ channelMessageId: seeded.inboundId });
      await outbound(seeded, key, status);
      const p = ports();

      await runAckDeadlineSweep(db.database, p.ports, AFTER_DUE);

      expect(p.facts.map((f) => f.status)).toEqual(['stopped']);
      expect(p.transport.bodies()).toEqual(['a stand-in late note']);
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
