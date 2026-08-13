import { type Database, schema } from '@hale/db';
import { type SQL, and, asc, eq, isNull, notLike, or } from 'drizzle-orm';
import { db as defaultDb } from '~/lib/db';
import { currentFamilyId, currentUserId } from '~/lib/family';
import {
  type TimelineMessage,
  loadTimeline,
  resolveConversationForParent,
} from './conversation';
import {
  CHANNEL_SMS_NOTE_KEY_LIKE,
  CHANNEL_SMS_THREAD_TITLE,
  channelSmsNoteKey,
  isChannelSmsNoteKey,
} from './note-key';

/**
 * Ask-session history reads: the family's conversation list (the Ask rail) and one
 * conversation's transcript (reopen). Read-only and scoped on TWO axes (rule #1) —
 * the caller's own family, so a thread is never listed or opened for another family,
 * AND the asking parent, so one co-parent never sees the other's text thread (which
 * note-key.ts keys per parent for exactly that reason). Web RSC imports
 * listConversations / getConversationTranscript directly (it already holds the
 * resolved family + db); the mobile routes call the loadConversations /
 * loadConversationTranscript wrappers, which resolve both the family and the parent
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

/**
 * The SQL half of the per-parent scope: keep the threads that are genuinely
 * family-shared (general Ask, note-anchored) plus the viewer's OWN text thread, and
 * drop every other parent's. Applied in the QUERY, not after it, so a co-parent's raw
 * texts are never fetched into this process at all (rule #1). Null viewer → neither
 * arm matches a text thread, so all of them drop: fails closed.
 */
function visibleToParent(viewerUserId: string | null): SQL | undefined {
  const shared = or(
    isNull(schema.conversations.noteKey),
    notLike(schema.conversations.noteKey, CHANNEL_SMS_NOTE_KEY_LIKE),
  );
  if (!viewerUserId) return shared;
  return or(shared, eq(schema.conversations.noteKey, channelSmsNoteKey(viewerUserId)));
}

/** Upper bound on a derived list title, ellipsis included. */
const TITLE_MAX_CHARS = 48;

function toTitle(content: string): string {
  const trimmed = content.trim();
  if (trimmed.length <= TITLE_MAX_CHARS) return trimmed;
  return `${trimmed.slice(0, TITLE_MAX_CHARS - 1).trimEnd()}…`;
}

/** The list title. A namespaced thread is named by its namespace; everything else is
 * named by what the parent asked first (VIL-220: see CHANNEL_SMS_THREAD_TITLE). */
function titleFor(noteKey: string | null, firstUserTurn: string | null): string {
  if (isChannelSmsNoteKey(noteKey)) return CHANNEL_SMS_THREAD_TITLE;
  return toTitle(firstUserTurn ?? '');
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
 * Lists the conversations THIS parent may see, newest-active first. `title` is the
 * first live user turn (truncated); soft-deleted turns are excluded from the count,
 * the title, and the sort stamp; a conversation with no live turn is dropped. Scoped
 * (rule #1) to `familyId` AND to `viewerUserId` — another parent's text thread is
 * excluded by the query itself, so its turns are never even fetched. Rows arrive in
 * createdAt order, so each conversation's first/last live turn falls out of a single
 * pass.
 */
export async function listConversations(
  familyId: string,
  viewerUserId: string | null,
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
    .where(and(eq(schema.conversations.familyId, familyId), visibleToParent(viewerUserId)))
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
      title: titleFor(agg.noteKey, agg.titleContent),
      noteKey: agg.noteKey,
      lastMessageAt: agg.lastAt.toISOString(),
      messageCount: agg.count,
    }))
    .sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt));
}

/**
 * Loads one conversation's ordered transcript, or null when it is unknown, owned by
 * another family, or the other parent's text thread. Both scopes are verified BEFORE
 * any message is read (rule #1: a thread that is not the caller's never leaks — they
 * get a 404). Soft-deleted turns are excluded by loadTimeline.
 */
export async function getConversationTranscript(
  familyId: string,
  viewerUserId: string | null,
  conversationId: string,
  database: Database,
): Promise<TimelineMessage[] | null> {
  const owned = await resolveConversationForParent(
    conversationId,
    familyId,
    viewerUserId,
    database,
  );
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
  return Promise.all([currentFamilyId(database), currentUserId(database)]).then(
    ([familyId, viewerUserId]) =>
      familyId ? listConversations(familyId, viewerUserId, database) : [],
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
  return Promise.all([currentFamilyId(database), currentUserId(database)]).then(
    ([familyId, viewerUserId]) =>
      familyId
        ? getConversationTranscript(familyId, viewerUserId, conversationId, database)
        : null,
  );
}
