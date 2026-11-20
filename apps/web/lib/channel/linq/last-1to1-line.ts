import { type Database, schema } from '@hale/db';
import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm';
import { SENT_STATUSES, isRealSendRow } from '~/lib/channel/ledger';

/**
 * The provider id of the newest line Hale sent this parent in their own 1:1, or
 * null when none reached the provider. A reply answers this line, so an ask that
 * is not this line is not what the reply answers.
 *
 * A row in another chat (a group line) is not this thread. A row with no chat id
 * is a 1:1 send whose chat the provider did not echo, so it still counts. A failed
 * or suppressed row never reached the parent.
 */
export async function lastOneToOneLineId(
  database: Database,
  input: { parentUserId: string; chatId: string },
): Promise<string | null> {
  const [row] = await database
    .select({ providerMessageId: schema.channelMessages.providerMessageId })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.parentUserId, input.parentUserId),
        eq(schema.channelMessages.channel, 'imessage'),
        eq(schema.channelMessages.direction, 'out'),
        inArray(schema.channelMessages.status, [...SENT_STATUSES]),
        isRealSendRow(),
        or(
          eq(schema.channelMessages.providerChatId, input.chatId),
          isNull(schema.channelMessages.providerChatId),
        ),
      ),
    )
    .orderBy(desc(schema.channelMessages.createdAt))
    .limit(1);
  return row?.providerMessageId ?? null;
}
