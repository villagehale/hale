import { type Database, schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { acceptedStatus } from '~/lib/channel/ledger';
import type { GroupLineSend } from '~/lib/channel/linq/group-onboarding-voice';
import { LinqSendError, sendLinqChatMessage } from '~/lib/channel/linq/transport';

/**
 * One already-written group reminder line into the chat: claimed on `channel_messages`
 * by its dedupe key before the send, so a replayed webhook or a second tick cannot post
 * it twice, stamped with the provider id once it lands, and audited `sms_reply_sent`.
 * A refused send marks the row failed and releases the key.
 */

export type GroupReminderLineOutcome =
  | { outcome: 'sent'; channelMessageId: string }
  | { outcome: 'already_sent' }
  /**
   * `retryable`: Linq answered with a refusal it calls temporary, so the line did not
   * land and trying again later cannot post it twice. A timeout or a dropped connection
   * may have landed, so it is never retryable.
   */
  | { outcome: 'not_sent'; code: string; retryable: boolean };

export async function postGroupReminderLine(
  database: Database,
  input: {
    familyId: string;
    /** Whose ledger row this is: the household's primary parent. */
    ledgerUserId: string;
    chatId: string;
    text: string;
    replyTo?: string;
    templateKey: string;
    dedupeKey: string;
    now: Date;
    send?: GroupLineSend;
  },
): Promise<GroupReminderLineOutcome> {
  const [claimed] = await database
    .insert(schema.channelMessages)
    .values({
      familyId: input.familyId,
      parentUserId: input.ledgerUserId,
      channel: 'imessage',
      direction: 'out',
      category: 'reply',
      templateKey: input.templateKey,
      dedupeKey: input.dedupeKey,
      providerChatId: input.chatId,
      status: acceptedStatus('imessage'),
      sentAt: input.now,
    })
    .onConflictDoNothing()
    .returning({ id: schema.channelMessages.id });
  if (!claimed) return { outcome: 'already_sent' };

  try {
    const sent = input.send
      ? await input.send({ chatId: input.chatId, text: input.text, replyTo: input.replyTo })
      : await sendLinqChatMessage({
          chatId: input.chatId,
          text: input.text,
          replyTo: input.replyTo ? { messageId: input.replyTo } : undefined,
        });
    await database
      .update(schema.channelMessages)
      .set({ providerMessageId: sent.providerMessageId })
      .where(eq(schema.channelMessages.id, claimed.id));
    await database.insert(schema.auditLog).values({
      familyId: input.familyId,
      actor: input.ledgerUserId,
      actionTaken: 'sms_reply_sent',
      targetTable: 'channel_messages',
      targetId: claimed.id,
      after: { templateKey: input.templateKey, source: 'composed' },
    });
    return { outcome: 'sent', channelMessageId: claimed.id };
  } catch (err) {
    const code = err instanceof LinqSendError ? err.code : 'unknown';
    const retryable = err instanceof LinqSendError && !err.permanent && err.httpStatus >= 400;
    await database
      .update(schema.channelMessages)
      .set({ status: 'failed', errorCode: code, dedupeKey: null })
      .where(eq(schema.channelMessages.id, claimed.id));
    console.warn(
      { familyId: input.familyId, code, retryable },
      'group reminder: the line did not land',
    );
    return { outcome: 'not_sent', code, retryable };
  }
}
