import { type Database, schema } from '@hale/db';
import { and, eq, isNull, lt, or } from 'drizzle-orm';
import { LinqSendError } from '~/lib/channel/linq/transport';
import { resolveSendablePhone } from '~/lib/channels/sms-consent-core';

export type ThreadProof = 'thread' | 'no_thread' | 'unread';

/**
 * VIL-735 · does this parent already have a 1:1 thread with Hale? A send to a number with
 * no thread opens one, and Hale never texts first, so the answer has to be proven.
 *
 * The proof is an inbound text from them in the chat Linq holds for Hale's line and their
 * CURRENT number. A Linq chat alone is not enough, because Hale's login code goes out on
 * the same line; an inbound `sms` row is not enough, because it predates Linq; and
 * `in_group` cannot be trusted either way, because older rows never had it set.
 *
 * `before` is a payment's session time: a new visitor who pays and then texts Hale has
 * their intake texts replayed later with their original times, and is still a new visitor.
 */
export async function payerThreadProof(
  database: Database,
  parentUserId: string,
  options: { before: Date | null; findDirectChat: (phone: string) => Promise<string | null> },
): Promise<ThreadProof> {
  const phone = await resolveSendablePhone(database, parentUserId);
  if (!phone) return 'no_thread';
  let chatId: string | null;
  try {
    chatId = await options.findDirectChat(phone);
  } catch (err) {
    if (err instanceof LinqSendError) return 'unread';
    throw err;
  }
  if (!chatId) return 'no_thread';
  const {
    parentUserId: parent,
    direction,
    providerChatId,
    sentAt,
    createdAt,
  } = schema.channelMessages;
  const [row] = await database
    .select({ id: schema.channelMessages.id })
    .from(schema.channelMessages)
    .where(
      and(
        eq(parent, parentUserId),
        eq(direction, 'in'),
        eq(providerChatId, chatId),
        options.before
          ? or(lt(sentAt, options.before), and(isNull(sentAt), lt(createdAt, options.before)))
          : undefined,
      ),
    )
    .limit(1);
  return row ? 'thread' : 'no_thread';
}
