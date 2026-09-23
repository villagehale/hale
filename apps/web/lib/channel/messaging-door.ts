import { type Database, schema } from '@hale/db';
import { and, desc, eq, inArray, isNotNull } from 'drizzle-orm';

/**
 * Which pipe an async parent text should leave on.
 *
 * The phone enrollment is one row (`parent_channels.kind = 'sms'`) for both
 * doors — the number is the person. The door is whichever pipe they used last.
 * An iMessage turn stores the Linq chat id on the inbound row; that is the
 * chat a later receipt has to return to. Falling through to Twilio would put
 * the sentence on a different app (a second identity). An SMS or WhatsApp
 * last turn stays on the phone transport this caller already had.
 *
 * No inbound phone row yet means SMS: that is the historical door, and a
 * connect receipt for someone we have never heard from on iMessage has no
 * chat to enter.
 */

const PHONE_CHANNELS = ['sms', 'whatsapp', 'imessage'] as const;

export type MessagingDoor =
  | { channel: 'sms' }
  | { channel: 'imessage'; chatId: string }
  /** The last turn was iMessage and no row stored a chat. Named so the caller
   * can refuse rather than text a different app. */
  | { channel: 'imessage'; chatId: null };

export async function resolveMessagingDoor(
  database: Database,
  parentUserId: string,
): Promise<MessagingDoor> {
  const [latest] = await database
    .select({
      channel: schema.channelMessages.channel,
      providerChatId: schema.channelMessages.providerChatId,
    })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.parentUserId, parentUserId),
        eq(schema.channelMessages.direction, 'in'),
        inArray(schema.channelMessages.channel, [...PHONE_CHANNELS]),
      ),
    )
    .orderBy(desc(schema.channelMessages.createdAt))
    .limit(1);

  if (latest?.channel !== 'imessage') return { channel: 'sms' };
  if (latest.providerChatId) return { channel: 'imessage', chatId: latest.providerChatId };

  // The newest inbound forgot its chat id. An earlier imessage row — inbound
  // or the outbound that answered it — may still have one. Using that keeps
  // the receipt in the thread the parent already has.
  const [withChat] = await database
    .select({ providerChatId: schema.channelMessages.providerChatId })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.parentUserId, parentUserId),
        eq(schema.channelMessages.channel, 'imessage'),
        isNotNull(schema.channelMessages.providerChatId),
      ),
    )
    .orderBy(desc(schema.channelMessages.createdAt))
    .limit(1);

  return { channel: 'imessage', chatId: withChat?.providerChatId ?? null };
}
