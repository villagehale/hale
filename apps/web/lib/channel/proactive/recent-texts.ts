import { type Database, schema } from '@hale/db';
import { and, desc, eq, gte, isNull, lte } from 'drizzle-orm';
import { channelSmsNoteKey } from '~/lib/coach/note-key';
import { SNAPSHOT_DAYS } from './snapshot';

/** How many of Hale's own recent texts the writer may read. Same bound as parent texts. */
const RECENT_ASSISTANT_TEXTS = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Texts Hale already sent this parent, newest first, inside the decider's window.
 *
 * The body lives on the parent's thread. `channel_messages` keeps none for a
 * check-in, so that ledger cannot tell the writer what was said. A text stamped
 * after this review's clock is the next review's.
 */
export async function recentAssistantTexts(
  database: Database,
  input: { familyId: string; parentUserId: string; now: Date },
): Promise<string[]> {
  const since = new Date(input.now.getTime() - SNAPSHOT_DAYS * DAY_MS);
  const rows = await database
    .select({ content: schema.messages.content })
    .from(schema.messages)
    .innerJoin(schema.conversations, eq(schema.messages.conversationId, schema.conversations.id))
    .where(
      and(
        eq(schema.conversations.familyId, input.familyId),
        eq(schema.conversations.noteKey, channelSmsNoteKey(input.parentUserId)),
        eq(schema.messages.role, 'assistant'),
        isNull(schema.messages.deletedAt),
        gte(schema.messages.createdAt, since),
        lte(schema.messages.createdAt, input.now),
      ),
    )
    .orderBy(desc(schema.messages.createdAt))
    .limit(RECENT_ASSISTANT_TEXTS);
  return rows.map((row) => row.content).filter((text) => text.trim().length > 0);
}
