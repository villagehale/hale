import { index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { conversations, messages } from './conversations.js';
import { families } from './families.js';

/**
 * Files a parent attaches to an Ask Hale message (a photo of a rash, a PDF lab
 * result). The bytes NEVER live here: `storagePath` points into the private
 * 'family-docs' Supabase Storage bucket (the SAME bucket the Docs vault uses, no new
 * bucket) under a `chat/{familyId}/{attachmentId}` prefix, read only through a
 * short-TTL server-minted signed URL (rule #1).
 *
 * `conversationId` and `messageId` are nullable: an attachment is uploaded BEFORE
 * the message exists, then linked (both set) when the /api/coach turn persists the
 * user message. An unlinked row (`messageId` null) is a pending, not-yet-consumed
 * upload. `originalName` is the client filename kept ONLY as a display label — it is
 * never part of the storage key and never reaches a log or trace (rule #1). The
 * audit trail lives in `audit_log`, so there is no soft-delete column.
 */
export const chatAttachments = pgTable(
  'chat_attachments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    /** The conversation the attachment was consumed into, or null until linked. */
    conversationId: uuid('conversation_id').references(() => conversations.id, {
      onDelete: 'cascade',
    }),
    /** The user message the attachment rides on, or null until linked. */
    messageId: uuid('message_id').references(() => messages.id, { onDelete: 'cascade' }),
    /** Path into the private 'family-docs' bucket: chat/{familyId}/{attachmentId}. */
    storagePath: text('storage_path').notNull(),
    mime: text('mime').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    /** The client filename, kept as a display label only (never in the path/logs/trace). */
    originalName: text('original_name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    conversationIdx: index('chat_attachments_conversation_idx').on(table.conversationId),
  }),
);

export type ChatAttachment = typeof chatAttachments.$inferSelect;
export type NewChatAttachment = typeof chatAttachments.$inferInsert;
