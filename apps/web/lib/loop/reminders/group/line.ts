import { type Database, schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import type { ChannelTransport } from '~/lib/channel/intake/transport';
import { acceptedStatus } from '~/lib/channel/ledger';
import {
  type GroupHoldReason,
  type GroupLineClass,
  groupAudienceAllows,
} from '~/lib/channel/linq/group-audience';
import type { GroupLineSend } from '~/lib/channel/linq/group-onboarding-voice';
import { LinqSendError, sendLinqChatMessage } from '~/lib/channel/linq/transport';
import { sendResolvingNewChat } from '~/lib/channel/outbound-transport';

/**
 * One already-written group reminder, sent: as a line into the family group, or as a
 * 1:1 text to the Hale customer who asked for their own. A group line reads the group's
 * audience at the moment of sending, after the model has written it, so someone added
 * or re-roled since the turn began still holds it. Either send is claimed on
 * `channel_messages` by its dedupe key, so a replayed webhook or a second tick cannot
 * send it twice, stamped with the provider id once it lands, and audited
 * `sms_reply_sent`. A refused send marks the row failed and releases the key.
 */

/** Every reminder line says what is due and when, so it is gated as a schedule line. */
const REMINDER_LINE: GroupLineClass = 'schedule';

export type GroupReminderSendOutcome =
  | { outcome: 'sent'; channelMessageId: string }
  | { outcome: 'already_sent' }
  /**
   * `retryable`: Linq answered with a refusal it calls temporary, so the text did not
   * land and trying again later cannot send it twice. A timeout or a dropped connection
   * may have landed, so it is never retryable.
   */
  | { outcome: 'not_sent'; code: string; retryable: boolean };

export type GroupReminderLineOutcome =
  | GroupReminderSendOutcome
  /** The group may not hear a schedule line now. Nothing was claimed or sent. */
  | { outcome: 'held'; reason: GroupHoldReason };

async function sendOnce(
  database: Database,
  entry: {
    familyId: string;
    ledgerUserId: string;
    templateKey: string;
    dedupeKey: string;
    /** The group chat a line goes into; a 1:1 text learns its chat from the send. */
    providerChatId: string | null;
    now: Date;
  },
  send: () => Promise<{ providerMessageId: string; chatId?: string | null }>,
): Promise<GroupReminderSendOutcome> {
  const [claimed] = await database
    .insert(schema.channelMessages)
    .values({
      familyId: entry.familyId,
      parentUserId: entry.ledgerUserId,
      channel: 'imessage',
      direction: 'out',
      category: 'reply',
      templateKey: entry.templateKey,
      dedupeKey: entry.dedupeKey,
      providerChatId: entry.providerChatId,
      status: acceptedStatus('imessage'),
      sentAt: entry.now,
    })
    .onConflictDoNothing()
    .returning({ id: schema.channelMessages.id });
  if (!claimed) return { outcome: 'already_sent' };

  try {
    const sent = await send();
    await database
      .update(schema.channelMessages)
      .set({
        providerMessageId: sent.providerMessageId,
        providerChatId: entry.providerChatId ?? sent.chatId ?? null,
      })
      .where(eq(schema.channelMessages.id, claimed.id));
    await database.insert(schema.auditLog).values({
      familyId: entry.familyId,
      actor: entry.ledgerUserId,
      actionTaken: 'sms_reply_sent',
      targetTable: 'channel_messages',
      targetId: claimed.id,
      after: { templateKey: entry.templateKey, source: 'composed' },
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
      { familyId: entry.familyId, templateKey: entry.templateKey, code, retryable },
      'group reminder: the text did not land',
    );
    return { outcome: 'not_sent', code, retryable };
  }
}

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
  const audience = await groupAudienceAllows(database, input.chatId, REMINDER_LINE);
  if (!audience.allowed) return { outcome: 'held', reason: audience.reason };

  return sendOnce(
    database,
    {
      familyId: input.familyId,
      ledgerUserId: input.ledgerUserId,
      templateKey: input.templateKey,
      dedupeKey: input.dedupeKey,
      providerChatId: input.chatId,
      now: input.now,
    },
    () =>
      input.send
        ? input.send({ chatId: input.chatId, text: input.text, replyTo: input.replyTo })
        : sendLinqChatMessage({
            chatId: input.chatId,
            text: input.text,
            replyTo: input.replyTo ? { messageId: input.replyTo } : undefined,
          }),
  );
}

/**
 * The asker's own reminder, texted to them 1:1 on Hale's line. The number comes from
 * their verified, unrevoked SMS channel and goes straight to the transport.
 */
export async function textGroupReminderDirect(
  database: Database,
  input: {
    familyId: string;
    userId: string;
    to: string;
    text: string;
    templateKey: string;
    dedupeKey: string;
    now: Date;
    transport: ChannelTransport;
  },
): Promise<GroupReminderSendOutcome> {
  return sendOnce(
    database,
    {
      familyId: input.familyId,
      ledgerUserId: input.userId,
      templateKey: input.templateKey,
      dedupeKey: input.dedupeKey,
      providerChatId: null,
      now: input.now,
    },
    () => sendResolvingNewChat(input.transport, { to: input.to, body: input.text }),
  );
}
