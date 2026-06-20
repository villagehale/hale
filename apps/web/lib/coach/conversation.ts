import { and, asc, eq } from 'drizzle-orm';
import { type Database, schema } from '@hale/db';

/**
 * Conversation persistence for multi-turn Ask Hale. A conversation is a
 * family-scoped thread; its messages are the running transcript the agent
 * re-reads each turn. Every read is keyed on (id AND family_id) so a caller can
 * never load — or append to — another family's thread (rule #1, family-scoped).
 */

export interface TranscriptMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** Creates a fresh conversation for a family and returns its id. */
export async function createConversation(
  familyId: string,
  database: Database,
): Promise<string> {
  const rows = await database
    .insert(schema.conversations)
    .values({ familyId })
    .returning({ id: schema.conversations.id });

  const id = rows[0]?.id;
  if (!id) {
    throw new Error('conversations insert returned no row');
  }
  return id;
}

/**
 * Resolves a conversation id to one OWNED by `familyId`. Returns the id when it
 * exists and belongs to the family; null otherwise (unknown id, or — the rule #1
 * case — a thread belonging to a different family). The caller starts a new
 * thread rather than leaking across families.
 */
export async function resolveConversationForFamily(
  conversationId: string,
  familyId: string,
  database: Database,
): Promise<string | null> {
  const rows = await database
    .select({ id: schema.conversations.id })
    .from(schema.conversations)
    .where(
      and(
        eq(schema.conversations.id, conversationId),
        eq(schema.conversations.familyId, familyId),
      ),
    )
    .limit(1);

  return rows[0]?.id ?? null;
}

/** Loads a conversation's transcript in chronological order. */
export async function loadTranscript(
  conversationId: string,
  database: Database,
): Promise<TranscriptMessage[]> {
  const rows = await database
    .select({ role: schema.messages.role, content: schema.messages.content })
    .from(schema.messages)
    .where(eq(schema.messages.conversationId, conversationId))
    .orderBy(asc(schema.messages.createdAt));

  return rows.map((r) => ({ role: r.role, content: r.content }));
}

/** Appends one message turn to a conversation. */
export async function appendMessage(
  conversationId: string,
  role: 'user' | 'assistant',
  content: string,
  database: Database,
): Promise<void> {
  await database.insert(schema.messages).values({ conversationId, role, content });
}
