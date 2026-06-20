import { and, asc, desc, eq } from 'drizzle-orm';
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

export interface RehydratedThread {
  conversationId: string;
  messages: TranscriptMessage[];
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

/**
 * Resolves the family's MOST RECENT conversation id, or null when the family has
 * no thread yet. Family-scoped (rule #1): only the requesting family's own
 * threads are ever considered. This is the rehydration anchor — the thread Ask
 * Hale replays on page load so visible history survives a refresh.
 */
export async function resolveLatestConversationForFamily(
  familyId: string,
  database: Database,
): Promise<string | null> {
  const rows = await database
    .select({ id: schema.conversations.id })
    .from(schema.conversations)
    .where(eq(schema.conversations.familyId, familyId))
    .orderBy(desc(schema.conversations.createdAt))
    .limit(1);

  return rows[0]?.id ?? null;
}

/**
 * Loads the family's latest thread with its persisted messages, or null when
 * there is nothing to rehydrate. The single read path Ask Hale uses on load so
 * the same conversation the agent persisted re-appears after a refresh.
 */
export async function loadLatestThread(
  familyId: string,
  database: Database,
): Promise<RehydratedThread | null> {
  const conversationId = await resolveLatestConversationForFamily(familyId, database);
  if (!conversationId) {
    return null;
  }

  const messages = await loadTranscript(conversationId, database);
  return { conversationId, messages };
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
