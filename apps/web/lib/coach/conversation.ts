import { type Database, schema } from '@hale/db';
import { and, asc, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { applyAttachmentMarkers } from './attachment-blocks.js';
import { isConversationVisibleToParent } from './note-key.js';

/**
 * Conversation persistence for multi-turn Ask Hale. A conversation is a
 * family-scoped thread; its messages are the running transcript the agent
 * re-reads each turn. Every read is keyed on (id AND family_id) so a caller can
 * never load — or append to — another family's thread (rule #1, family-scoped).
 */

/** A Database handle OR an open transaction — lets a writer run standalone or, when
 * two writes must commit atomically (the user message + its attachment link), inside
 * the SAME transaction. */
export type Db = Database | Parameters<Parameters<Database['transaction']>[0]>[0];

export interface TranscriptMessage {
  /**
   * `assistant` is Hale's own text. `user` is the parent. `tool` is external
   * content (a mailbox snippet) and is not Hale's history and not the parent's.
   */
  role: 'user' | 'assistant' | 'tool';
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
export async function createConversation(familyId: string, database: Database): Promise<string> {
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
 * Resolves the conversation anchored to `noteKey` for `familyId`, or null when the
 * note has no thread yet. Read-only (rule #1: family-scoped) — the re-open path a
 * mobile thread uses to replay a note's prior reply exchange. A note key names at
 * most one conversation per family (the partial unique index), so this returns a
 * single id.
 */
export async function resolveNoteConversation(
  familyId: string,
  noteKey: string,
  database: Database,
): Promise<string | null> {
  const rows = await database
    .select({ id: schema.conversations.id })
    .from(schema.conversations)
    .where(
      and(eq(schema.conversations.familyId, familyId), eq(schema.conversations.noteKey, noteKey)),
    )
    .limit(1);

  return rows[0]?.id ?? null;
}

/**
 * Resolves the conversation anchored to `noteKey`, creating it if none exists yet.
 * The write path a note reply takes: the first reply on a note opens its thread,
 * every later reply continues it. Idempotent and race-safe — the insert conflicts
 * against the partial unique (family_id, note_key) index and falls back to a
 * re-read, so two concurrent first-replies resolve to the SAME conversation rather
 * than forking (rule #6: one continuous, auditable thread per note).
 */
export async function resolveOrCreateNoteConversation(
  familyId: string,
  noteKey: string,
  database: Database,
): Promise<string> {
  const existing = await resolveNoteConversation(familyId, noteKey, database);
  if (existing) {
    return existing;
  }

  const inserted = await database
    .insert(schema.conversations)
    .values({ familyId, noteKey })
    .onConflictDoNothing()
    .returning({ id: schema.conversations.id });
  if (inserted[0]?.id) {
    return inserted[0].id;
  }

  // A concurrent first-reply won the insert — re-read its row rather than fork.
  const raced = await resolveNoteConversation(familyId, noteKey, database);
  if (!raced) {
    throw new Error('resolveOrCreateNoteConversation: conflict but no row found');
  }
  return raced;
}

/**
 * Resolves a conversation id to one this PARENT may open. Returns the id when it
 * exists, belongs to `familyId`, AND is not another parent's text thread; null
 * otherwise. The caller starts a new thread rather than leaking into someone else's.
 *
 * Two scopes, because family alone is not enough (rule #1). Family keeps other
 * households out. The per-parent check keeps a co-parent out of the one namespace
 * that is private WITHIN a household — the SMS thread, which note-key.ts keys per
 * parent precisely so two phones never merge into one transcript. Everything else
 * (general Ask, note-anchored replies) is family-shared and resolves for either
 * parent. This is the single reader for "may I open this thread?", so a caller
 * cannot check one scope and forget the other.
 */
export async function resolveConversationForParent(
  conversationId: string,
  familyId: string,
  viewerUserId: string | null,
  database: Database,
): Promise<string | null> {
  const rows = await database
    .select({ id: schema.conversations.id, noteKey: schema.conversations.noteKey })
    .from(schema.conversations)
    .where(
      and(eq(schema.conversations.id, conversationId), eq(schema.conversations.familyId, familyId)),
    )
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  return isConversationVisibleToParent(row.noteKey, viewerUserId) ? row.id : null;
}

/**
 * Resolves the family's MOST RECENT general conversation id, or null when the
 * family has no thread yet. Family-scoped (rule #1): only the requesting family's
 * own threads are ever considered. This is the rehydration anchor — the thread Ask
 * Hale replays on page load so visible history survives a refresh. Note-anchored
 * conversations (note_key set) are EXCLUDED: a reply on a Messages note lives in
 * its own thread and must never surface as the family's general Ask Hale history.
 */
export async function resolveLatestConversationForFamily(
  familyId: string,
  database: Database,
): Promise<string | null> {
  const rows = await database
    .select({ id: schema.conversations.id })
    .from(schema.conversations)
    .where(and(eq(schema.conversations.familyId, familyId), isNull(schema.conversations.noteKey)))
    .orderBy(desc(schema.conversations.createdAt))
    .limit(1);

  return rows[0]?.id ?? null;
}

/**
 * Loads the family's one continuous conversation with its full timeline, or null
 * when there is nothing to rehydrate. The single read path the Ask Hale shell uses
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

/** Hale's stored text, plus a mailbox snippet as its own `tool` turn when one may be
 * shown. The snippet is not appended to the assistant turn: that would make sender
 * text look like Hale's history. A 13+ child's snippet is null and adds no turn.
 * No parent-facing sentence is added here. */
export function emailSourceTurns(
  role: 'user' | 'assistant',
  content: string,
  source: schema.MessageSource | null,
): TranscriptMessage[] {
  const turn: TranscriptMessage = { role, content };
  if (
    role !== 'assistant' ||
    source?.kind !== 'gmail' ||
    source.snippet == null ||
    source.snippet === ''
  ) {
    return [turn];
  }
  return [
    turn,
    {
      role: 'tool',
      content: JSON.stringify({
        kind: 'gmail',
        trust: 'external',
        gmailMessageId: source.gmailMessageId,
        eventId: source.eventId,
        snippet: source.snippet,
      }),
    },
  ];
}

let sourceColumnAbsentLogged = false;

function noteSourceColumnAbsent(): void {
  if (sourceColumnAbsentLogged) return;
  sourceColumnAbsentLogged = true;
  console.error(
    { outcome: 'messages_source_unavailable' },
    'messages: source column absent, transcript is content only',
  );
}

/** Drizzle names every column on insert and select. `source` is 0198, so a database
 * that has not applied it must not mention the column at all. */
async function messagesHaveSource(database: Db): Promise<boolean> {
  const result = (await database.execute(sql`
    select 1 as present
    from information_schema.columns
    where table_schema = 'public' and table_name = 'messages' and column_name = 'source'
    limit 1
  `)) as { rows?: unknown[] } | unknown[];
  const rows = Array.isArray(result) ? result : (result.rows ?? []);
  return rows.length > 0;
}

function insertedId(result: unknown): string | undefined {
  const rows = Array.isArray(result)
    ? result
    : ((result as { rows?: Array<{ id: string }> }).rows ?? []);
  return rows[0]?.id;
}

function liveMessages(conversationId: string) {
  return and(eq(schema.messages.conversationId, conversationId), isNull(schema.messages.deletedAt));
}

async function readTranscriptRows(
  conversationId: string,
  database: Database,
): Promise<
  Array<{ role: 'user' | 'assistant'; content: string; source: schema.MessageSource | null }>
> {
  if (!(await messagesHaveSource(database))) {
    noteSourceColumnAbsent();
    const rows = await database
      .select({ role: schema.messages.role, content: schema.messages.content })
      .from(schema.messages)
      .where(liveMessages(conversationId))
      .orderBy(asc(schema.messages.createdAt));
    return rows.map((row) => ({ ...row, source: null }));
  }
  return database
    .select({
      role: schema.messages.role,
      content: schema.messages.content,
      source: schema.messages.source,
    })
    .from(schema.messages)
    .where(liveMessages(conversationId))
    .orderBy(asc(schema.messages.createdAt));
}

/** Loads a conversation's transcript in chronological order. Soft-deleted turns
 * (deleted_at stamped) are excluded so a removed turn never re-enters the agent's
 * context (rule #6 soft-delete: the row survives for audit, the read drops it).
 * A mailbox snippet, when stored, follows Hale's text as a `tool` turn. It is not
 * part of that text. A database that has not applied 0198 is read without `source`. */
export async function loadTranscript(
  conversationId: string,
  database: Database,
): Promise<TranscriptMessage[]> {
  const rows = await readTranscriptRows(conversationId, database);
  return rows.flatMap((row) => emailSourceTurns(row.role, row.content, row.source));
}

/** One turn's scope, persisted on the message so the timeline can filter on it. */
export interface MessageScope {
  childId: string | null;
  topic: string | null;
  /** What a proactive turn was about (messages.source, 0198). Omitted = null. */
  source?: schema.MessageSource | null;
}

/** Appends one message turn to a conversation, carrying its scope (child + topic).
 * Returns the new message id so the caller can link per-turn rows (e.g. chat
 * attachments) to the exact message that was just written. */
export async function appendMessage(
  conversationId: string,
  role: 'user' | 'assistant',
  content: string,
  database: Db,
  scope: MessageScope = { childId: null, topic: null },
): Promise<string> {
  const keepSource = scope.source != null && (await messagesHaveSource(database));
  if (scope.source != null && !keepSource) noteSourceColumnAbsent();
  // Raw SQL, not Drizzle: an insert builder names every column, including `source`,
  // and that fails on a database that has not applied 0198.
  const inserted = await database.execute(
    keepSource
      ? sql`insert into messages (conversation_id, role, content, child_id, topic, source)
            values (${conversationId}, ${role}, ${content}, ${scope.childId}, ${scope.topic}, ${JSON.stringify(scope.source)}::jsonb)
            returning id`
      : sql`insert into messages (conversation_id, role, content, child_id, topic)
            values (${conversationId}, ${role}, ${content}, ${scope.childId}, ${scope.topic})
            returning id`,
  );
  const id = insertedId(inserted);
  if (!id) {
    throw new Error('messages insert returned no row');
  }
  return id;
}

/**
 * The agent-facing transcript: the same in-order, live-only turns loadTranscript
 * returns, but with a `[attachment: <mime>]` marker appended to any PAST turn that
 * carried a chat attachment. The bytes are NEVER replayed (rule #1, and to avoid
 * re-sending an image every turn) — the current turn's fresh attachment rides as
 * native content blocks, past turns ride as markers. Family scope is inherited: the
 * conversationId was already resolved to the caller's family upstream.
 */
export async function loadTranscriptWithAttachments(
  conversationId: string,
  database: Database,
): Promise<TranscriptMessage[]> {
  const rows = (await messagesHaveSource(database))
    ? await database
        .select({
          id: schema.messages.id,
          role: schema.messages.role,
          content: schema.messages.content,
          source: schema.messages.source,
        })
        .from(schema.messages)
        .where(liveMessages(conversationId))
        .orderBy(asc(schema.messages.createdAt))
    : (
        await database
          .select({
            id: schema.messages.id,
            role: schema.messages.role,
            content: schema.messages.content,
          })
          .from(schema.messages)
          .where(liveMessages(conversationId))
          .orderBy(asc(schema.messages.createdAt))
      ).map((row) => ({ ...row, source: null }));

  const attachmentRows = await database
    .select({
      messageId: schema.chatAttachments.messageId,
      mime: schema.chatAttachments.mime,
    })
    .from(schema.chatAttachments)
    .where(
      and(
        eq(schema.chatAttachments.conversationId, conversationId),
        isNotNull(schema.chatAttachments.messageId),
      ),
    );

  const mimesByMessage = new Map<string, string[]>();
  for (const a of attachmentRows) {
    if (!a.messageId) continue;
    const list = mimesByMessage.get(a.messageId) ?? [];
    list.push(a.mime);
    mimesByMessage.set(a.messageId, list);
  }

  const marked = applyAttachmentMarkers(rows, mimesByMessage);
  return marked.flatMap((turn, index) =>
    emailSourceTurns(turn.role, turn.content, rows[index]?.source ?? null),
  );
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
      and(eq(schema.messages.conversationId, conversationId), isNull(schema.messages.deletedAt)),
    )
    .orderBy(asc(schema.messages.createdAt));

  // `activity_held` is the coach-only note of options that did not fit in a follow-up
  // (channel/activity/venue-pages.ts ACTIVITY_HELD_TOPIC). The coach transcript still
  // loads it; the receipts timeline does not show the JSON.
  return rows
    .filter((r) => r.topic !== 'activity_held')
    .map((r) => ({
      id: r.id,
      role: r.role,
      content: r.content,
      childId: r.childId,
      topic: r.topic,
      createdAt: r.createdAt.toISOString(),
    }));
}
