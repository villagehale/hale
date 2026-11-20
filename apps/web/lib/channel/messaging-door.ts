import { type Database, schema } from '@hale/db';
import { and, desc, eq, inArray, isNotNull, isNull, ne, or } from 'drizzle-orm';

/**
 * Which pipe an async parent text should leave on.
 *
 * The phone enrollment is one row (`parent_channels.kind = 'sms'`) for both
 * doors — the number is the person. The door is whichever pipe they used last.
 * An iMessage turn stores the Linq chat id on the inbound row; that is the
 * chat a later receipt has to return to. Falling through to SMS would put
 * the sentence on a different app (a second identity). An SMS last turn stays
 * on the phone transport this caller already had. WhatsApp is retired, so a
 * historical whatsapp row is not a door.
 *
 * No inbound phone row yet means SMS: that is the historical door, and a
 * connect receipt for someone we have never heard from on iMessage has no
 * chat to enter.
 *
 * The newest inbound text picks the app; the chat is a separate question. A
 * chat is a door only if an inbound row recorded it as one-to-one
 * (`in_group = false`): a group text, an outbound send's chat, and a row whose
 * group bit is unknown never are. Someone whose only chats are groups is an
 * iMessage person with no chat at all, and the caller refuses.
 *
 * `excludeChatId` is a chat that must never be the door — the family group,
 * for a message meant for one person. It only narrows further.
 */

const PHONE_CHANNELS = ['sms', 'imessage'] as const;

export type MessagingDoor =
  | { channel: 'sms' }
  | { channel: 'imessage'; chatId: string }
  /** The last turn was iMessage and no row stored a chat. Named so the caller
   * can refuse rather than text a different app. */
  | { channel: 'imessage'; chatId: null };

export async function resolveMessagingDoor(
  database: Database,
  parentUserId: string,
  options: { excludeChatId?: string | null } = {},
): Promise<MessagingDoor> {
  const excluded = options.excludeChatId;
  const [latest] = await database
    .select({ channel: schema.channelMessages.channel })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.parentUserId, parentUserId),
        eq(schema.channelMessages.direction, 'in'),
        inArray(schema.channelMessages.channel, [...PHONE_CHANNELS]),
        excluded
          ? or(
              isNull(schema.channelMessages.providerChatId),
              ne(schema.channelMessages.providerChatId, excluded),
            )
          : undefined,
      ),
    )
    .orderBy(desc(schema.channelMessages.createdAt))
    .limit(1);

  if (!latest) {
    if (!excluded || !(await spokeIn(database, parentUserId, excluded))) return { channel: 'sms' };
  } else if (latest.channel !== 'imessage') {
    return { channel: 'sms' };
  }

  const [withChat] = await database
    .select({ providerChatId: schema.channelMessages.providerChatId })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.parentUserId, parentUserId),
        eq(schema.channelMessages.direction, 'in'),
        eq(schema.channelMessages.channel, 'imessage'),
        eq(schema.channelMessages.inGroup, false),
        isNotNull(schema.channelMessages.providerChatId),
        excluded ? ne(schema.channelMessages.providerChatId, excluded) : undefined,
      ),
    )
    .orderBy(desc(schema.channelMessages.createdAt))
    .limit(1);

  return { channel: 'imessage', chatId: withChat?.providerChatId ?? null };
}

async function spokeIn(database: Database, parentUserId: string, chatId: string): Promise<boolean> {
  const [row] = await database
    .select({ id: schema.channelMessages.id })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.parentUserId, parentUserId),
        eq(schema.channelMessages.direction, 'in'),
        eq(schema.channelMessages.providerChatId, chatId),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * The service Linq said carried this parent's texts in this chat: `provider_service` on
 * their newest inbound row there that names one. Linq relays green-bubble SMS and RCS
 * chats as `imessage` too, so the channel alone cannot say the chat is iMessage. Null:
 * they have not texted in it since Linq started saying, which is not a yes.
 */
export async function chatServiceSaid(
  database: Database,
  parentUserId: string,
  chatId: string,
): Promise<schema.LinqServiceValue | null> {
  const [row] = await database
    .select({ service: schema.channelMessages.providerService })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.parentUserId, parentUserId),
        eq(schema.channelMessages.direction, 'in'),
        eq(schema.channelMessages.providerChatId, chatId),
        isNotNull(schema.channelMessages.providerService),
      ),
    )
    .orderBy(desc(schema.channelMessages.createdAt))
    .limit(1);
  return row?.service ?? null;
}
