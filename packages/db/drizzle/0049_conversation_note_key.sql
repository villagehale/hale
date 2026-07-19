-- Anchor a coach conversation to a single Hale note (additive only, rule #9). A
-- reply on a real Messages note (`digest-…` / `action-…`) continues ONE persistent
-- coach thread; `note_key` is that anchor. Nullable: the general Ask Hale thread
-- leaves it null. NOT a content column — an opaque note id only; the note's content
-- is never stored here (rule #1). No RLS change (conversations already carries its
-- policy; the app scopes every read by family_id).
ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "note_key" text;--> statement-breakpoint
-- At most one note-anchored conversation per (family, note) — makes a re-open resolve
-- the same thread rather than fork a new one. Partial (note_key NOT NULL) so the
-- general thread's null key is unconstrained, and it is the conflict target the
-- resolve-or-create upsert races against.
CREATE UNIQUE INDEX IF NOT EXISTS "conversations_family_note_key_idx" ON "conversations" USING btree ("family_id","note_key") WHERE "note_key" IS NOT NULL;
