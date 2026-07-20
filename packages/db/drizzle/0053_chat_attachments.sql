-- chat_attachments: files a parent attaches to an Ask Hale message (photos of a
-- rash, a PDF lab result). Additive only (rule #9). Same private 'family-docs'
-- Supabase Storage bucket as the Docs vault — no new bucket — under a distinct
-- chat/{family_id}/{attachment_id} prefix; the bytes NEVER live in Postgres and are
-- read only through a short-TTL server-minted signed URL (rule #1).
--
-- conversation_id and message_id are nullable: an attachment is uploaded BEFORE the
-- message row exists, then linked (both set) once the /api/coach turn persists the
-- user message. An unlinked row (message_id NULL) is a pending, not-yet-consumed
-- upload. original_name is the client filename kept ONLY as a display label; it is
-- never part of the storage key (the key is the server-minted id) and never reaches
-- a log or Langfuse trace (rule #1). The audit trail lives in audit_log, so there is
-- no soft-delete column here.
CREATE TABLE "chat_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL,
	"conversation_id" uuid,
	"message_id" uuid,
	"storage_path" text NOT NULL,
	"mime" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"original_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_attachments" ADD CONSTRAINT "chat_attachments_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_attachments" ADD CONSTRAINT "chat_attachments_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_attachments" ADD CONSTRAINT "chat_attachments_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- The per-turn marker replay (loadTranscriptWithAttachments) scans a conversation's
-- linked rows; validation/link/read scan by (family_id, id) off the primary key.
CREATE INDEX "chat_attachments_conversation_idx" ON "chat_attachments" USING btree ("conversation_id");--> statement-breakpoint
-- Deny-by-default for the PostgREST Data API roles, same posture as child_documents
-- (0042). The app connects as postgres (BYPASSRLS); Hale never uses the Data API.
ALTER TABLE "chat_attachments" ENABLE ROW LEVEL SECURITY;
