import { describe, expect, it, vi } from 'vitest';
import type { Database } from '@hale/db';
import { eraseConversation, softDeleteMessage } from './conversation-delete';

/**
 * Deleting Ask Hale history is family-scoped + audited (rules #1, #6) and SOFT:
 * it stamps deleted_at rather than issuing a DELETE, so the audit row that
 * references the turn survives (right-to-access). These tests drive the fake tx
 * through both paths — a turn the family owns (stamped + audited) and one it does
 * not (rejected, no write) — and prove the erase stamps every live turn under the
 * conversation and audits once.
 */

const FAMILY_ID = '11111111-1111-4111-8111-111111111111';
const ACTOR_USER_ID = '55555555-5555-4555-8555-555555555555';
const MESSAGE_ID = '22222222-2222-4222-8222-222222222222';
const CONVERSATION_ID = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2026-07-03T12:00:00.000Z');

/**
 * Fakes the transaction the mutations run in. `scopeRows` is what the family-scope
 * guard select resolves (a non-empty array = the family owns the target). `stamped`
 * is what update().returning() yields (the turns whose deleted_at was set). Spies
 * capture the SET payload, the audit insert, and whether an UPDATE happened at all.
 */
function fakeDb(scopeRows: Array<{ id: string }>, stamped: Array<{ id: string }>) {
  const set = vi.fn();
  const values = vi.fn().mockResolvedValue(undefined);

  const tx = {
    select: () => ({
      from: () => ({
        innerJoin: () => ({ where: () => ({ limit: async () => scopeRows }) }),
        where: () => ({ limit: async () => scopeRows }),
      }),
    }),
    update: () => ({
      set: (payload: unknown) => {
        set(payload);
        return { where: () => ({ returning: async () => stamped }) };
      },
    }),
    insert: () => ({ values }),
  };

  const db = {
    transaction: (fn: (t: typeof tx) => unknown) => fn(tx),
  } as unknown as Database;

  return { db, spies: { set, values } };
}

describe('softDeleteMessage', () => {
  it('stamps deleted_at (a SOFT delete, never a DELETE) and audits when the family owns the turn', async () => {
    const { db, spies } = fakeDb([{ id: MESSAGE_ID }], [{ id: MESSAGE_ID }]);

    const ok = await softDeleteMessage(db, {
      messageId: MESSAGE_ID,
      familyId: FAMILY_ID,
      actorUserId: ACTOR_USER_ID,
      now: NOW,
    });

    expect(ok).toBe(true);
    expect(spies.set).toHaveBeenCalledWith({ deletedAt: NOW });
    expect(spies.values).toHaveBeenCalledWith(
      expect.objectContaining({
        familyId: FAMILY_ID,
        actor: ACTOR_USER_ID,
        actionTaken: 'coach_turn_deleted',
        targetTable: 'messages',
        targetId: MESSAGE_ID,
      }),
    );
  });

  it('rejects a turn the family does not own — no stamp, no audit row (rule #1)', async () => {
    const { db, spies } = fakeDb([], []);

    const ok = await softDeleteMessage(db, {
      messageId: MESSAGE_ID,
      familyId: FAMILY_ID,
      actorUserId: ACTOR_USER_ID,
      now: NOW,
    });

    expect(ok).toBe(false);
    expect(spies.set).not.toHaveBeenCalled();
    expect(spies.values).not.toHaveBeenCalled();
  });

  it('is a no-op on an already-deleted turn: nothing stamped, no audit row', async () => {
    // Family owns it, but the deleted_at IS NULL guard matches nothing to stamp.
    const { db, spies } = fakeDb([{ id: MESSAGE_ID }], []);

    const ok = await softDeleteMessage(db, {
      messageId: MESSAGE_ID,
      familyId: FAMILY_ID,
      actorUserId: ACTOR_USER_ID,
      now: NOW,
    });

    expect(ok).toBe(false);
    expect(spies.values).not.toHaveBeenCalled();
  });
});

describe('eraseConversation', () => {
  it('soft-deletes every live turn and writes one audit row when the family owns the conversation', async () => {
    const { db, spies } = fakeDb([{ id: CONVERSATION_ID }], [{ id: 'm0' }, { id: 'm1' }]);

    const erased = await eraseConversation(db, {
      conversationId: CONVERSATION_ID,
      familyId: FAMILY_ID,
      actorUserId: ACTOR_USER_ID,
      now: NOW,
    });

    expect(erased).toBe(2);
    expect(spies.set).toHaveBeenCalledWith({ deletedAt: NOW });
    expect(spies.values).toHaveBeenCalledTimes(1);
    expect(spies.values).toHaveBeenCalledWith(
      expect.objectContaining({
        familyId: FAMILY_ID,
        actor: ACTOR_USER_ID,
        actionTaken: 'coach_conversation_erased',
        targetTable: 'conversations',
        targetId: CONVERSATION_ID,
        after: { erasedTurns: 2 },
      }),
    );
  });

  it('rejects a conversation the family does not own — returns null, no write (rule #1)', async () => {
    const { db, spies } = fakeDb([], []);

    const erased = await eraseConversation(db, {
      conversationId: CONVERSATION_ID,
      familyId: FAMILY_ID,
      actorUserId: ACTOR_USER_ID,
      now: NOW,
    });

    expect(erased).toBeNull();
    expect(spies.set).not.toHaveBeenCalled();
    expect(spies.values).not.toHaveBeenCalled();
  });

  it('erases an already-empty conversation as 0 turns and writes no audit row', async () => {
    const { db, spies } = fakeDb([{ id: CONVERSATION_ID }], []);

    const erased = await eraseConversation(db, {
      conversationId: CONVERSATION_ID,
      familyId: FAMILY_ID,
      actorUserId: ACTOR_USER_ID,
      now: NOW,
    });

    expect(erased).toBe(0);
    expect(spies.values).not.toHaveBeenCalled();
  });
});
