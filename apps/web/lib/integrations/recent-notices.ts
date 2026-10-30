import { type Database, schema } from '@hale/db';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { resolveNoteConversation } from '~/lib/coach/conversation';
import { channelSmsNoteKey } from '~/lib/coach/note-key';

/** How many of the newest lines the writer sees. A handful: context, not a history. */
export const RECENT_NOTICES = 3;

/**
 * What Hale already texted this parent in their own 1:1, newest first, so a notice can
 * read as the next line of that thread. It reads the thread the coach re-reads
 * (channel/thread.ts threadProactiveMessage), never the ledger: an email alert's ledger
 * row keeps no body (rule #1). Only this parent's own thread: never another parent's,
 * never a group chat, never another family. It reads, and never creates, the thread.
 */
export async function readRecentNotices(
  database: Database,
  input: { familyId: string; parentUserId: string },
): Promise<string[]> {
  const conversationId = await resolveNoteConversation(
    input.familyId,
    channelSmsNoteKey(input.parentUserId),
    database,
  );
  if (!conversationId) return [];
  const rows = await database
    .select({ content: schema.messages.content })
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.conversationId, conversationId),
        eq(schema.messages.role, 'assistant'),
        isNull(schema.messages.deletedAt),
      ),
    )
    .orderBy(desc(schema.messages.createdAt))
    .limit(RECENT_NOTICES);
  return rows.map((row) => row.content.trim()).filter((line) => line !== '');
}
