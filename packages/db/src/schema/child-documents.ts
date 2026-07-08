import { index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { children } from './children.js';
import { families } from './families.js';
import { users } from './users.js';

/**
 * The family's Docs vault — the most sensitive artifacts Hale holds (immunization
 * records, insurance cards). The bytes NEVER live here: `storagePath` points into
 * the private 'family-docs' Supabase Storage bucket ({familyId}/{docId}) and is
 * only ever read through a short-TTL server-minted signed URL (rule #1).
 *
 * The original client filename is deliberately absent — `title` (sanitized) is the
 * only human label, and no client-supplied name reaches the storage key (no PII in
 * the path). `uploadedBy` (users.id) is the author, driving the rule-#1 teen
 * redaction's parent-authored exemption exactly as episodes' `authoredBy` does:
 * a 13+ child's doc is visible ONLY to its uploader. `deletedAt` is a soft delete
 * so the row the audit trail references (rule #6) stays intact.
 */
export const childDocuments = pgTable(
  'child_documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    familyId: uuid('family_id')
      .notNull()
      .references(() => families.id, { onDelete: 'cascade' }),
    /** Which child this doc is for, when attributable. Null = family-wide.
     * ON DELETE SET NULL: removing a child must not delete the family's docs. */
    childId: uuid('child_id').references(() => children.id, { onDelete: 'set null' }),
    /** The parent who uploaded it (users.id) — the teen-redaction author. */
    uploadedBy: uuid('uploaded_by')
      .notNull()
      .references(() => users.id),
    /** Free-text category: 'health' | 'insurance' | 'other'. Not a DB enum so a new
     * category lands without a migration; the route validates the allowlist. */
    kind: text('kind').notNull(),
    /** The sanitized human label (never the client filename). */
    title: text('title').notNull(),
    /** Path into the private 'family-docs' bucket: {familyId}/{docId}. */
    storagePath: text('storage_path').notNull(),
    mime: text('mime').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** NULL = live, a timestamp = soft-deleted by the family. */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => ({
    familyDeletedIdx: index('child_documents_family_deleted_idx').on(
      table.familyId,
      table.deletedAt,
    ),
  }),
);

export type ChildDocument = typeof childDocuments.$inferSelect;
export type NewChildDocument = typeof childDocuments.$inferInsert;
