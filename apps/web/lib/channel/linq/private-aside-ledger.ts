import { type Database, schema } from '@hale/db';
import { and, asc, desc, eq, isNotNull, ne, sql } from 'drizzle-orm';

/**
 * Where a private aside's words live (VIL-457). The text went to one adult, the family's
 * primary parent, so it is kept on that adult's own 1:1 `channel_messages` row and read
 * back from there. The family audit row, which every adult's copy carries, says only that
 * an aside went out.
 */

export const PRIVATE_ASIDE_TEMPLATE = 'linq:private_aside';

const DEDUPE_PREFIX = 'linq:private_aside:';

export function privateAsideDedupeKey(input: {
  chatId: string;
  inboundId: string;
  familyId: string;
}): string {
  return `${DEDUPE_PREFIX}${input.chatId}:${input.inboundId}:${input.familyId}`;
}

/** This family's last delivered aside from this group chat, or null when none. */
export async function lastDeliveredAside(
  database: Database,
  input: { chatId: string; familyId: string },
): Promise<{ text: string; at: Date } | null> {
  const [row] = await database
    .select({ body: schema.channelMessages.body, at: schema.channelMessages.createdAt })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.familyId, input.familyId),
        eq(schema.channelMessages.templateKey, PRIVATE_ASIDE_TEMPLATE),
        eq(schema.channelMessages.direction, 'out'),
        ne(schema.channelMessages.status, 'failed'),
        isNotNull(schema.channelMessages.body),
        sql`starts_with(${schema.channelMessages.dedupeKey}, ${`${DEDUPE_PREFIX}${input.chatId}:`})`,
      ),
    )
    .orderBy(desc(schema.channelMessages.createdAt))
    .limit(1);
  return row?.body ? { text: row.body, at: row.at } : null;
}

/** Every aside Hale sent this adult, oldest first, for their own right-to-access copy. */
export async function privateAsidesSentTo(
  database: Database,
  input: { familyId: string; userId: string },
): Promise<{ text: string; sentAt: Date }[]> {
  const rows = await database
    .select({ body: schema.channelMessages.body, at: schema.channelMessages.createdAt })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.familyId, input.familyId),
        eq(schema.channelMessages.parentUserId, input.userId),
        eq(schema.channelMessages.templateKey, PRIVATE_ASIDE_TEMPLATE),
        eq(schema.channelMessages.direction, 'out'),
        ne(schema.channelMessages.status, 'failed'),
        isNotNull(schema.channelMessages.body),
      ),
    )
    .orderBy(asc(schema.channelMessages.createdAt));
  return rows.flatMap((row) => (row.body ? [{ text: row.body, sentAt: row.at }] : []));
}
