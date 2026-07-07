import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import { type Database, schema } from '@hale/db';

/**
 * Conversation persistence for the multi-turn Concierge. A conversation is a
 * family-scoped thread; its messages are the running transcript the agent
 * re-reads each turn. Every read is keyed on (id AND family_id) so a caller can
 * never load — or append to — another family's thread (rule #1, family-scoped).
 */

export interface TranscriptMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** A transcript turn carrying its scope — the shape the timeline filters on. */
export interface TimelineMessage extends TranscriptMessage {
  id: string;
  /** Which child the turn was focused on, or null for the whole family. */
  childId: string | null;
  /** Coarse topic tag for filtering, or null when untagged. */
  topic: string | null;
  createdAt: string;
}

export interface RehydratedThread {
  conversationId: string;
  /** The one conversation's full timeline, scope-tagged for filtering. */
  timeline: TimelineMessage[];
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
 * Loads the family's one continuous conversation with its full timeline, or null
 * when there is nothing to rehydrate. The single read path the Concierge shell uses
 * on load so the same conversation the agent persisted re-appears after a refresh.
 */
export async function loadLatestThread(
  familyId: string,
  database: Database,
): Promise<RehydratedThread | null> {
  const conversationId = await resolveLatestConversationForFamily(familyId, database);
  if (!conversationId) {
    return null;
  }

  const timeline = await loadTimeline(conversationId, database);
  return { conversationId, timeline };
}

/** Loads a conversation's transcript in chronological order. Soft-deleted turns
 * (deleted_at stamped) are excluded so a removed turn never re-enters the agent's
 * context (rule #6 soft-delete: the row survives for audit, the read drops it). */
export async function loadTranscript(
  conversationId: string,
  database: Database,
): Promise<TranscriptMessage[]> {
  const rows = await database
    .select({ role: schema.messages.role, content: schema.messages.content })
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.conversationId, conversationId),
        isNull(schema.messages.deletedAt),
      ),
    )
    .orderBy(asc(schema.messages.createdAt));

  return rows.map((r) => ({ role: r.role, content: r.content }));
}

/** One turn's scope, persisted on the message so the timeline can filter on it. */
export interface MessageScope {
  childId: string | null;
  topic: string | null;
}

/** Appends one message turn to a conversation, carrying its scope (child + topic). */
export async function appendMessage(
  conversationId: string,
  role: 'user' | 'assistant',
  content: string,
  database: Database,
  scope: MessageScope = { childId: null, topic: null },
): Promise<void> {
  await database
    .insert(schema.messages)
    .values({ conversationId, role, content, childId: scope.childId, topic: scope.topic });
}

/**
 * Loads a conversation's full timeline — every turn with its scope — in
 * chronological order. The single read the continuous-companion shell rehydrates:
 * the family's ONE ongoing conversation as a scrollable, filterable history.
 */
export async function loadTimeline(
  conversationId: string,
  database: Database,
): Promise<TimelineMessage[]> {
  const rows = await database
    .select({
      id: schema.messages.id,
      role: schema.messages.role,
      content: schema.messages.content,
      childId: schema.messages.childId,
      topic: schema.messages.topic,
      createdAt: schema.messages.createdAt,
    })
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.conversationId, conversationId),
        isNull(schema.messages.deletedAt),
      ),
    )
    .orderBy(asc(schema.messages.createdAt));

  return rows.map((r) => ({
    id: r.id,
    role: r.role,
    content: r.content,
    childId: r.childId,
    topic: r.topic,
    createdAt: r.createdAt.toISOString(),
  }));
}
