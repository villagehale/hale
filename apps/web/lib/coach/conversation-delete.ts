import { type Database, schema } from '@hale/db';
import { and, eq, isNull } from 'drizzle-orm';

/**
 * Deletion of Concierge history, family-scoped + audited (rules #1, #6). A parent
 * may remove a SINGLE turn or ERASE the whole conversation from /coach. Both are
 * SOFT deletes — stamp `deleted_at`, never a hard DELETE — so the audit row that
 * references the turn stays intact (rule #6, PIPEDA right-to-access), matching the
 * quick-log episode posture (softDeleteEpisode). The read path already filters
 * `deleted_at IS NULL`, so a stamped turn leaves every timeline and the agent's
 * context immediately.
 *
 * Family scope (rule #1): a turn/conversation is only ever mutable through its
 * OWNING family. The guard joins message → conversation → family, so a turn under
 * another family's conversation matches nothing and the call returns false with no
 * write — a parent can never delete another family's history.
 */

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * Soft-deletes ONE turn the family owns. Returns true when a live turn was stamped,
 * false when no live turn with that id belongs to the family (unknown id, foreign
 * family, or already deleted) — no write, no audit row. Idempotent: a re-delete of
 * an already-stamped turn is a no-op false. Writes ONE audit_log row on success.
 */
export async function softDeleteMessage(
  database: Database,
  args: { messageId: string; familyId: string; actorUserId: string; now?: Date },
): Promise<boolean> {
  const { messageId, familyId, actorUserId } = args;
  const now = args.now ?? new Date();

  return database.transaction(async (tx) => {
    if (!(await messageBelongsToFamily(tx, messageId, familyId))) {
      return false;
    }

    const stamped = await tx
      .update(schema.messages)
      .set({ deletedAt: now })
      .where(and(eq(schema.messages.id, messageId), isNull(schema.messages.deletedAt)))
      .returning({ id: schema.messages.id });
    if (stamped.length === 0) {
      return false;
    }

    await tx.insert(schema.auditLog).values({
      familyId,
      actor: actorUserId,
      actionTaken: 'coach_turn_deleted',
      targetTable: 'messages',
      targetId: messageId,
      after: { deleted: true },
    });
    return true;
  });
}

/**
 * Erases a whole conversation the family owns: soft-deletes every LIVE turn in it
 * (one stamp across the set). Returns the number of turns stamped, or null when the
 * conversation does not belong to the family (unknown id or foreign family) — no
 * write, no audit row. A conversation whose turns are all already deleted stamps 0
 * and writes no audit row (nothing changed). Writes ONE audit_log row (targeting the
 * conversation) when at least one turn was stamped.
 */
export async function eraseConversation(
  database: Database,
  args: { conversationId: string; familyId: string; actorUserId: string; now?: Date },
): Promise<number | null> {
  const { conversationId, familyId, actorUserId } = args;
  const now = args.now ?? new Date();

  return database.transaction(async (tx) => {
    if (!(await conversationBelongsToFamily(tx, conversationId, familyId))) {
      return null;
    }

    const stamped = await tx
      .update(schema.messages)
      .set({ deletedAt: now })
      .where(
        and(
          eq(schema.messages.conversationId, conversationId),
          isNull(schema.messages.deletedAt),
        ),
      )
      .returning({ id: schema.messages.id });

    if (stamped.length === 0) {
      return 0;
    }

    await tx.insert(schema.auditLog).values({
      familyId,
      actor: actorUserId,
      actionTaken: 'coach_conversation_erased',
      targetTable: 'conversations',
      targetId: conversationId,
      after: { erasedTurns: stamped.length },
    });
    return stamped.length;
  });
}

/** True when the message's conversation belongs to the family (rule #1). */
async function messageBelongsToFamily(
  tx: Tx,
  messageId: string,
  familyId: string,
): Promise<boolean> {
  const rows = await tx
    .select({ id: schema.messages.id })
    .from(schema.messages)
    .innerJoin(schema.conversations, eq(schema.conversations.id, schema.messages.conversationId))
    .where(and(eq(schema.messages.id, messageId), eq(schema.conversations.familyId, familyId)))
    .limit(1);
  return rows.length > 0;
}

/** True when the conversation belongs to the family (rule #1). */
async function conversationBelongsToFamily(
  tx: Tx,
  conversationId: string,
  familyId: string,
): Promise<boolean> {
  const rows = await tx
    .select({ id: schema.conversations.id })
    .from(schema.conversations)
    .where(
      and(eq(schema.conversations.id, conversationId), eq(schema.conversations.familyId, familyId)),
    )
    .limit(1);
  return rows.length > 0;
}
