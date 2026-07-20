import { type Database, schema } from '@hale/db';
import { asc, eq } from 'drizzle-orm';
import { db as defaultDb } from '~/lib/db';
import { currentFamilyId } from '~/lib/family';
import {
  type TimelineMessage,
  loadTimeline,
  resolveConversationForFamily,
} from './conversation';

/**
 * Ask-session history reads: the family's conversation list (the Ask rail) and one
 * conversation's transcript (reopen). Read-only and family-scoped (rule #1) — every
 * read is keyed on the caller's OWN family, so a thread is never listed or opened for
 * another family. Web RSC imports listConversations / getConversationTranscript
 * directly (it already holds the resolved family + db); the mobile routes call the
 * loadConversations / loadConversationTranscript wrappers, which resolve the family
 * from the session first, mirroring loadMessages.
 *
 * Continuation is unchanged: /api/coach already reopens a conversation by
 * conversationId. This seam only adds listing + transcript reads.
 */

/** One row of the Ask-session list. `title` is derived server-side from the first
 * live user turn; the raw transcript never leaves through this shape. */
export interface ConversationSummary {
  id: string;
  title: string;
  /** The Hale note this thread is anchored to, or null for the general Ask thread. */
  noteKey: string | null;
  /** ISO instant of the most recent live turn — the list's sort key. */
  lastMessageAt: string;
  /** Count of live (non-soft-deleted) turns. */
  messageCount: number;
}

/** Upper bound on a derived list title, ellipsis included. */
const TITLE_MAX_CHARS = 48;

function toTitle(content: string): string {
  const trimmed = content.trim();
  if (trimmed.length <= TITLE_MAX_CHARS) return trimmed;
  return `${trimmed.slice(0, TITLE_MAX_CHARS - 1).trimEnd()}…`;
}

interface HistoryRow {
  conversationId: string;
  noteKey: string | null;
  role: 'user' | 'assistant';
  content: string;
  createdAt: Date;
  deletedAt: Date | null;
}

/**
 * Lists a family's conversations, newest-active first. `title` is the first live
 * user turn (truncated); soft-deleted turns are excluded from the count, the title,
 * and the sort stamp; a conversation with no live turn is dropped. Family-scoped
 * (rule #1): only conversations owned by `familyId` are ever read. Rows arrive in
 * createdAt order, so each conversation's first/last live turn falls out of a single
 * pass.
 */
export async function listConversations(
  familyId: string,
  database: Database,
): Promise<ConversationSummary[]> {
  const rows: HistoryRow[] = await database
    .select({
      conversationId: schema.messages.conversationId,
      noteKey: schema.conversations.noteKey,
      role: schema.messages.role,
      content: schema.messages.content,
      createdAt: schema.messages.createdAt,
      deletedAt: schema.messages.deletedAt,
    })
    .from(schema.messages)
    .innerJoin(schema.conversations, eq(schema.messages.conversationId, schema.conversations.id))
    .where(eq(schema.conversations.familyId, familyId))
    .orderBy(asc(schema.messages.createdAt));

  const byConversation = new Map<
    string,
    { noteKey: string | null; titleContent: string | null; count: number; lastAt: Date }
  >();

  for (const row of rows) {
    if (row.deletedAt !== null) continue;
    const existing = byConversation.get(row.conversationId);
    if (!existing) {
      byConversation.set(row.conversationId, {
        noteKey: row.noteKey,
        titleContent: row.role === 'user' ? row.content : null,
        count: 1,
        lastAt: row.createdAt,
      });
      continue;
    }
    existing.count += 1;
    existing.lastAt = row.createdAt;
    if (existing.titleContent === null && row.role === 'user') {
      existing.titleContent = row.content;
    }
  }

  return [...byConversation.entries()]
    .map(([id, agg]) => ({
      id,
      title: toTitle(agg.titleContent ?? ''),
      noteKey: agg.noteKey,
      lastMessageAt: agg.lastAt.toISOString(),
      messageCount: agg.count,
    }))
    .sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt));
}

/**
 * Loads one conversation's ordered transcript, or null when it is unknown or owned
 * by another family. Ownership is verified against `familyId` BEFORE any message is
 * read (rule #1: a foreign thread never leaks — the caller gets a 404). Soft-deleted
 * turns are excluded by loadTimeline.
 */
export async function getConversationTranscript(
  familyId: string,
  conversationId: string,
  database: Database,
): Promise<TimelineMessage[] | null> {
  const owned = await resolveConversationForFamily(conversationId, familyId, database);
  if (!owned) {
    return null;
  }
  return loadTimeline(conversationId, database);
}

/**
 * Session-scoped wrapper for the mobile list route: resolves the caller's family and
 * lists their conversations. Degrades to an empty list in the credential-less
 * preview / when no family resolves, mirroring loadMessages.
 */
export function loadConversations(): Promise<ConversationSummary[]> {
  if (!process.env.DATABASE_URL) return Promise.resolve([]);
  const database = defaultDb();
  return currentFamilyId(database).then((familyId) =>
    familyId ? listConversations(familyId, database) : [],
  );
}

/**
 * Session-scoped wrapper for the mobile reopen route: resolves the caller's family
 * and loads the transcript, family-scoped (rule #1). Null (→ 404) when no family
 * resolves or the conversation is not the family's own.
 */
export function loadConversationTranscript(
  conversationId: string,
): Promise<TimelineMessage[] | null> {
  if (!process.env.DATABASE_URL) return Promise.resolve(null);
  const database = defaultDb();
  return currentFamilyId(database).then((familyId) =>
    familyId ? getConversationTranscript(familyId, conversationId, database) : null,
  );
}
