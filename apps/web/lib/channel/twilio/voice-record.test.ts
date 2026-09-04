import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { channelSmsNoteKey } from '~/lib/coach/note-key';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { reconcileUnhandedInbound } from './reconcile';
import { voiceCallRecorder } from './voice-record';

const AT = new Date('2026-08-19T15:00:00.000Z');

/**
 * ONE Postgres for the file, a fresh FAMILY and a fresh CALL per test.
 *
 * Booting PGlite and replaying every migration costs the better part of a second, and
 * the count only ever grows — a per-test database made this one file seven of them and
 * pushed two unrelated PGlite suites past vitest's 5s default under parallel load.
 * Isolation comes from the ids instead, which is where it actually matters: every
 * assertion is scoped to its own familyId, and the call sid is unique per test because
 * `channel_messages_inbound_provider_msg_uniq` is global and a shared sid would make one
 * test's rows collide with another's.
 */
let db: TestDb;
let callCounter = 0;

function nextCallSid(): string {
  callCounter += 1;
  return `CA${String(callCounter).padStart(32, '0')}`;
}

beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});

describe('voiceCallRecorder', () => {
  let ticket: { callSid: string; familyId: string; parentUserId: string };

  beforeEach(async () => {
    const family = await seedFamily(db.database);
    ticket = { callSid: nextCallSid(), ...family };
  });

  const rows = () =>
    db.database
      .select()
      .from(schema.channelMessages)
      .where(eq(schema.channelMessages.familyId, ticket.familyId));

  const audits = () =>
    db.database
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.familyId, ticket.familyId));

  it('puts a call into the SAME thread the parent already texts in', async () => {
    const recorder = voiceCallRecorder(db.database);
    const first = await recorder.openThread(ticket);
    const again = await recorder.openThread(ticket);

    expect(first).toBe(again);
    const [conversation] = await db.database
      .select({ noteKey: schema.conversations.noteKey })
      .from(schema.conversations)
      .where(eq(schema.conversations.id, first));
    // The anchor the SMS router threads on (route.ts), not a second one of voice's own.
    expect(conversation?.noteKey).toBe(channelSmsNoteKey(ticket.parentUserId));
  });

  it("records the caller's words as a voice row, in the thread, with an audit row", async () => {
    const recorder = voiceCallRecorder(db.database);
    const conversationId = await recorder.openThread(ticket);
    await recorder.callerSaid({
      ticket,
      conversationId,
      text: 'when is swim this week',
      turnIndex: 1,
      at: AT,
    });

    const [row] = await rows();
    expect(row).toMatchObject({
      channel: 'voice',
      direction: 'in',
      category: 'reply',
      status: 'delivered',
      body: 'when is swim this week',
      relatedConversationId: conversationId,
      providerMessageId: `${ticket.callSid}:t1:in`,
    });
    // Marked handed off AT BIRTH: a spoken turn has already been answered by the call,
    // and an unmarked inbound row is what the SMS reconciler exists to re-drive.
    expect(row?.handedOffAt).not.toBeNull();

    const [message] = await db.database
      .select({ role: schema.messages.role, content: schema.messages.content })
      .from(schema.messages)
      .where(eq(schema.messages.conversationId, conversationId));
    expect(message).toEqual({ role: 'user', content: 'when is swim this week' });

    expect((await audits()).map((a) => a.actionTaken)).toEqual(['voice_turn_received']);
  });

  it('records what Hale SAID in the thread but never in the ledger body (rule #1)', async () => {
    const recorder = voiceCallRecorder(db.database);
    const conversationId = await recorder.openThread(ticket);
    await recorder.haleSaid({
      ticket,
      conversationId,
      text: 'Swim is Thursday at four thirty.',
      turnIndex: 1,
      at: AT,
    });

    const [row] = await rows();
    expect(row).toMatchObject({
      channel: 'voice',
      direction: 'out',
      category: 'reply',
      status: 'sent',
      body: null,
      relatedConversationId: conversationId,
    });

    const [message] = await db.database
      .select({ role: schema.messages.role, content: schema.messages.content })
      .from(schema.messages)
      .where(eq(schema.messages.conversationId, conversationId));
    expect(message).toEqual({
      role: 'assistant',
      content: 'Swim is Thursday at four thirty.',
    });
    expect((await audits()).map((a) => a.actionTaken)).toEqual(['voice_turn_spoken']);
  });

  it('is idempotent per turn: a redelivered frame does not answer the thread twice', async () => {
    const recorder = voiceCallRecorder(db.database);
    const conversationId = await recorder.openThread(ticket);
    const turn = { ticket, conversationId, text: 'when is swim', turnIndex: 1, at: AT };

    await recorder.callerSaid(turn);
    await recorder.callerSaid(turn);

    expect(await rows()).toHaveLength(1);
    const messages = await db.database
      .select({ id: schema.messages.id })
      .from(schema.messages)
      .where(eq(schema.messages.conversationId, conversationId));
    expect(messages).toHaveLength(1);
  });

  it('writes exactly ONE immutable row for the call itself (rule #6)', async () => {
    const recorder = voiceCallRecorder(db.database);
    await recorder.callEnded({
      ticket,
      outcome: 'time_capped',
      turns: 7,
      durationMs: 540_000,
      at: AT,
    });

    const entries = await audits();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      actionTaken: 'voice_call_completed',
      actor: ticket.parentUserId,
      // The call's one DB anchor: the relay claim row, keyed by the call sid.
      targetTable: 'voice_relay_claims',
      targetId: ticket.callSid,
    });
    expect(entries[0]?.after).toEqual({
      callSid: ticket.callSid,
      outcome: 'time_capped',
      turns: 7,
      durationMs: 540_000,
    });
  });

  it('never puts a phone number or a spoken word in the call audit row (rule #1)', async () => {
    const recorder = voiceCallRecorder(db.database);
    await recorder.callEnded({
      ticket,
      outcome: 'completed',
      turns: 1,
      durationMs: 1000,
      at: AT,
    });
    const [entry] = await audits();
    expect(JSON.stringify(entry?.after)).not.toMatch(/\+1|swim|said/i);
  });
});

describe('the SMS reconciler and voice rows', () => {
  it('never re-drives a spoken turn into the SMS coach — and still sweeps a real text', async () => {
    const family = await seedFamily(db.database);
    const ticket = { callSid: nextCallSid(), ...family };
    const longAgo = new Date(Date.now() - 10 * 60 * 1000);

    const recorder = voiceCallRecorder(db.database);
    const conversationId = await recorder.openThread(ticket);
    await recorder.callerSaid({
      ticket,
      conversationId,
      text: 'when is swim',
      turnIndex: 1,
      at: longAgo,
    });
    // Age the voice row into the reconciler's window and clear the birth mark, so the
    // ONLY thing keeping it out of the sweep is its channel.
    await db.database
      .update(schema.channelMessages)
      .set({ createdAt: longAgo, handedOffAt: null })
      .where(
        and(
          eq(schema.channelMessages.familyId, family.familyId),
          eq(schema.channelMessages.channel, 'voice'),
        ),
      );

    // The positive control: a real unanswered TEXT, same family, same age.
    await db.database.insert(schema.channelMessages).values({
      familyId: family.familyId,
      parentUserId: family.parentUserId,
      channel: 'sms',
      direction: 'in',
      category: 'reply',
      providerMessageId: 'SM0000000000000000000000000000001',
      status: 'delivered',
      body: 'and gym?',
      sentAt: longAgo,
      createdAt: longAgo,
    });

    const enqueue = vi.fn(async (_job: { provider_message_id: string }) => {});
    const summary = await reconcileUnhandedInbound({
      database: db.database,
      enqueue,
      log: { warn: vi.fn(), error: vi.fn() },
    });

    expect(summary).toEqual({ scanned: 1, redriven: 1, failed: 0 });
    expect(enqueue.mock.calls[0]?.[0]?.provider_message_id).toBe(
      'SM0000000000000000000000000000001',
    );

    const [voiceRow] = await db.database
      .select({ handedOffAt: schema.channelMessages.handedOffAt })
      .from(schema.channelMessages)
      .where(
        and(
          eq(schema.channelMessages.familyId, family.familyId),
          eq(schema.channelMessages.channel, 'voice'),
        ),
      );
    expect(voiceRow?.handedOffAt).toBeNull();
  });
});
