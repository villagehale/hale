import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { FakeReplyTransport } from '~/lib/channel/router/reply-route';
import { auditTurnLedger } from '~/lib/channel/router/wiring';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import type { AckCompose, LateNoteFacts } from './compose';
import { recordAckPromise } from './promise';
import {
  ACK_LATE_NOTE_STALE_MS,
  ACK_SWEEP_BUDGET_MS,
  type AckDeadlinePorts,
  runAckDeadlineSweep,
} from './sweep';

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

async function seedPromise(channel: 'sms' | 'imessage' = 'imessage') {
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
    askedAt: ASKED_AT,
    promisedMinutes: PROMISED_MINUTES,
    now: ACK_AT,
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
});
