import { type Database, schema } from '@hale/db';
import { sql } from 'drizzle-orm';
import { appendMessage, resolveOrCreateNoteConversation } from '~/lib/coach/conversation';
import { channelSmsNoteKey } from '~/lib/coach/note-key';
import type { RelayTicket } from './relay-token';
import type { VoiceCallRecorder, VoiceCallOutcome, VoiceTurnRecord } from './relay-session';

/**
 * Voice v1 — what a spoken conversation leaves behind.
 *
 * A call is not a separate product and must not leave a separate trail. Everything here
 * writes into the machinery a text already writes into: the parent's ONE long-lived
 * conversation (the same `channel:sms:<parent>` anchor the router threads on), the
 * `channel_messages` ledger, and the audit log. A parent who calls on Tuesday and texts
 * on Wednesday is having one conversation, and the thread the coach reads on Wednesday
 * has to contain Tuesday.
 *
 * Two things differ from a text, and both are facts rather than choices:
 *
 *   THE CHANNEL IS 'voice'. Nothing was sent through a message provider, so calling it
 *   'sms' would put a message that does not exist into the table a PIPEDA right-to-
 *   access read is built from. It also keeps these rows out of
 *   `reconcileUnhandedInbound`, whose select is sms 'reply' rows — a spoken turn swept in
 *   there would be answered a second time, by text, five minutes later (#443's shape).
 *
 *   THE INBOUND ROW IS MARKED HANDED OFF AT BIRTH. The call answered it; there is no
 *   queue owing it a reply. That is belt to the channel filter's braces, and it is the
 *   half that stays true if the reconciler ever widens its select.
 *
 * The BODY discipline is the ledger's, unchanged: inbound rows carry the caller's own
 * words (the same reason A3 stores an inbound text — it is the parent's instruction),
 * outbound rows carry none, because Hale's words live in `messages` and a second copy in
 * a delivery table is household detail sitting where only delivery belongs (rule #1).
 */

/** The provider's handle on one spoken turn. A CallSid plus a turn number is the natural
 * identity of a turn, and it is what makes a redelivered frame lose the unique index
 * instead of answering a parent twice. Never collides with a Twilio MessageSid. */
function turnProviderId(callSid: string, turnIndex: number, direction: 'in' | 'out'): string {
  return `${callSid}:t${turnIndex}:${direction}`;
}

export function voiceCallRecorder(database: Database): VoiceCallRecorder {
  return {
    async openThread(ticket: RelayTicket): Promise<string> {
      return resolveOrCreateNoteConversation(
        ticket.familyId,
        channelSmsNoteKey(ticket.parentUserId),
        database,
      );
    },

    /**
     * The caller's turn, written BEFORE the answer is composed — they said it, so it is
     * true whatever happens next, including a turn that breaks.
     *
     * The insert IS the claim, exactly as it is in the inbound webhook: a frame Twilio
     * redelivers loses `channel_messages_inbound_provider_msg_uniq` and stops here rather
     * than putting the same sentence in the thread twice.
     */
    async callerSaid(record: VoiceTurnRecord): Promise<void> {
      const [row] = await database
        .insert(schema.channelMessages)
        .values({
          familyId: record.ticket.familyId,
          parentUserId: record.ticket.parentUserId,
          channel: 'voice',
          direction: 'in',
          category: 'reply',
          providerMessageId: turnProviderId(record.ticket.callSid, record.turnIndex, 'in'),
          status: 'delivered',
          body: record.text,
          relatedConversationId: record.conversationId,
          sentAt: record.at,
          handedOffAt: record.at,
        })
        .onConflictDoNothing({
          target: schema.channelMessages.providerMessageId,
          where: sql`${schema.channelMessages.direction} = 'in' AND ${schema.channelMessages.providerMessageId} IS NOT NULL`,
        })
        .returning({ id: schema.channelMessages.id });
      if (!row) return;

      await appendMessage(record.conversationId, 'user', record.text, database);
      await database.insert(schema.auditLog).values({
        familyId: record.ticket.familyId,
        actor: record.ticket.parentUserId,
        actionTaken: 'voice_turn_received',
        targetTable: 'channel_messages',
        targetId: row.id,
      });
    },

    /**
     * What Hale actually said — already truncated by the session to what the caller
     * heard, so the thread records the conversation that happened.
     *
     * IT HANDS BACK THE LEDGER ROW'S ID, because a promise spoken in this turn is minted
     * against it (voice-promise.ts). That is the MEM-10 send-time discipline arriving on
     * a channel with no transport: over SMS the row is the message the carrier accepted,
     * and here it is the row that says the caller heard the words. Both answer the same
     * question — is there something to point the parent at — and neither lets a promise
     * exist without one.
     */
    async haleSaid(record: VoiceTurnRecord): Promise<string> {
      const [row] = await database
        .insert(schema.channelMessages)
        .values({
          familyId: record.ticket.familyId,
          parentUserId: record.ticket.parentUserId,
          channel: 'voice',
          direction: 'out',
          category: 'reply',
          providerMessageId: turnProviderId(record.ticket.callSid, record.turnIndex, 'out'),
          status: 'sent',
          body: null,
          relatedConversationId: record.conversationId,
          sentAt: record.at,
        })
        .returning({ id: schema.channelMessages.id });
      if (!row) {
        throw new Error('voice recorder: channel_messages insert returned no row');
      }

      await appendMessage(record.conversationId, 'assistant', record.text, database);
      await database.insert(schema.auditLog).values({
        familyId: record.ticket.familyId,
        actor: record.ticket.parentUserId,
        actionTaken: 'voice_turn_spoken',
        targetTable: 'channel_messages',
        targetId: row.id,
      });
      return row.id;
    },

    /**
     * The call itself, on the record (rule #6): what it was, how it ended, how long, how
     * many turns.
     *
     * Facts about the CALL and nothing about the conversation — no number, no transcript,
     * no summary. The turns are already rows; this row is the one an operator or a
     * right-to-access export reads to know the call happened at all.
     */
    async callEnded(record: {
      ticket: RelayTicket;
      outcome: VoiceCallOutcome;
      turns: number;
      durationMs: number;
      at: Date;
    }): Promise<void> {
      await database.insert(schema.auditLog).values({
        familyId: record.ticket.familyId,
        actor: record.ticket.parentUserId,
        actionTaken: 'voice_call_completed',
        after: {
          callSid: record.ticket.callSid,
          outcome: record.outcome,
          turns: record.turns,
          durationMs: record.durationMs,
        },
      });
    },
  };
}
