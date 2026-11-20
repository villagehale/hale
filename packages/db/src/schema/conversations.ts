import { sql } from 'drizzle-orm';
import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { children } from './children.js';
import { families } from './families.js';
import { users } from './users.js';

/**
 * Multi-turn Ask Hale threads. A conversation is a family-scoped container; its
 * messages are the running transcript the agent re-reads to keep context across
 * turns. Family-scoped (rule #1: a thread belongs to exactly one family — its
 * messages are never visible to another). The transcript carries only what the
 * parent typed and Hale's plain-prose answers; raw child content never enters it
 * (the teen-redaction guard runs upstream at the tool boundary).
 *
 * `noteKey` anchors a conversation to a single Hale note (a mobile Messages row —
 * `digest-…` / `action-…`) so replying on that note continues ONE persistent coach
 * thread across app restarts. It is nullable: the general Ask Hale thread carries a
 * null key, and only note-anchored threads set it. The partial unique index makes
 * "at most one conversation per (family, note)" true by construction, so a re-open
 * resolves the same thread rather than forking a new one.
 */
export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    /** The Hale note this thread is anchored to (`digest-…` / `action-…`), or null
     * for the general Ask Hale thread. NOT a content field — an opaque anchor only;
     * the note's content is never stored here (rule #1). */
    noteKey: text('note_key'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    familyIdx: index('conversations_family_idx').on(table.familyId),
    // VIL-447 (0216): the target of group_lists' (conversation_id, family_id) FK, so a
    // shared list can only point at its own family's thread.
    idFamilyUniq: uniqueIndex('conversations_id_family_uniq').on(table.id, table.familyId),
    // At most one note-anchored conversation per (family, note). Partial (note_key
    // NOT NULL) so the general thread — which leaves note_key null — is unconstrained.
    familyNoteKeyIdx: uniqueIndex('conversations_family_note_key_idx')
      .on(table.familyId, table.noteKey)
      .where(sql`${table.noteKey} IS NOT NULL`),
  }),
);

/**
 * One turn in a conversation — a parent question (`user`) or Hale's answer
 * (`assistant`). Append-only; the (conversation_id, created_at) index serves the
 * in-order replay the agent reads to ground each new turn.
 *
 * `childId` and `topic` scope a turn so the family's ONE continuous conversation
 * reads as a searchable timeline filterable by child and by topic. Both are
 * nullable: a turn can be about the whole family (no child) and an untagged turn
 * is valid (topic null). ON DELETE SET NULL on `childId` — a removed child must
 * not cascade-delete the family's conversation history.
 */
/** What a proactive email-alert turn was about, so the coach can answer a reply to it.
 * The SMS itself stays the notice text. VIL-619: no sender words are stored here, only
 * ids and whether the email is private. `private` is a 13+ child's mail: `read_email`
 * refuses it and no later turn is told its id. */
export interface GmailMessageSource {
  kind: 'gmail';
  eventId: string | null;
  gmailMessageId: string;
  private: boolean;
}

/** A row written before VIL-619 stored the snippet itself, and null meant private. Read,
 * never written. The one-time scrub (apps/web/scripts/scrub-email-alert-snippets.ts)
 * rewrites these as {@link GmailMessageSource}. */
export interface LegacyGmailMessageSource {
  kind: 'gmail';
  eventId: string | null;
  gmailMessageId: string;
  snippet: string | null;
}

/** VIL-616 · a reply the coach wrote after `read_email` handed its turn an email's text.
 * It may repeat the sender's words, so the nightly memory writer skips the row. */
export interface EmailReadMessageSource {
  kind: 'read_email';
}

/** What a writer may store. */
export type MessageSource = GmailMessageSource | EmailReadMessageSource;

/** What a reader may find, until the scrub has run. */
export type StoredMessageSource = MessageSource | LegacyGmailMessageSource;

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    role: text('role').$type<'user' | 'assistant'>().notNull(),
    content: text('content').notNull(),
    /** Which child the parent was focused on for this turn, or null for the whole family. */
    childId: uuid('child_id').references(() => children.id, { onDelete: 'set null' }),
    /** Coarse topic tag (health/sleep/feeding/…) for timeline filtering; null when untagged. */
    topic: text('topic'),
    /** What a proactive turn was about (0212). Null for every turn that has none.
     * Never copied to a log or an audit row. */
    source: jsonb('source').$type<StoredMessageSource>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Soft delete (rule #6 / #9): a parent-removed turn is stamped, not erased, so
     * the audit row that references it stays intact. NULL = live; the read path
     * (loadTimeline/loadTranscript) filters a stamped row out. */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    /**
     * VIL-479 · Linq message id of this turn: an assistant bubble Hale can edit in
     * place, or (flag on) the parent's own iMessage, so their edit reaches the thread.
     * Null on SMS turns and on rows written before this column existed.
     */
    providerMessageId: text('provider_message_id'),
    /**
     * VIL-597 (G8) · Who sent a user turn, as the channel writers know it. A group thread
     * holds every seated member's texts, so `role = 'user'` does not mean the parent. Null
     * on assistant turns and on rows written before this column existed.
     */
    authorUserId: uuid('author_user_id').references(() => users.id, { onDelete: 'set null' }),
  },
  (table) => ({
    conversationTimeIdx: index('messages_conversation_time_idx').on(
      table.conversationId,
      table.createdAt,
    ),
    conversationDeletedIdx: index('messages_conversation_deleted_idx').on(
      table.conversationId,
      table.deletedAt,
    ),
    providerMessageUniq: uniqueIndex('messages_provider_message_id_uniq')
      .on(table.providerMessageId)
      .where(sql`${table.providerMessageId} IS NOT NULL`),
    roleCheck: check('messages_role_check', sql`${table.role} IN ('user', 'assistant')`),
  }),
);

export type Conversation = typeof conversations.$inferSelect;
export type NewConversation = typeof conversations.$inferInsert;
export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
