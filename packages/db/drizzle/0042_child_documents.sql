-- child_documents: the family's Docs vault — the most sensitive artifacts yet
-- (immunization records, insurance cards, medical letters). Additive only (rule #9).
--
-- storage_path points into the PRIVATE 'family-docs' Supabase Storage bucket
-- ({family_id}/{doc_id}); the bytes NEVER live in Postgres and are only ever read
-- through a short-TTL server-minted signed URL (rule #1, most restrictive). The
-- original client filename is deliberately NOT stored — a title (sanitized) is the
-- only human label, and no client-supplied name reaches the storage key (no PII in
-- the path).
--
-- child_id is nullable + ON DELETE SET NULL: a doc may be family-wide, and removing
-- a child must not delete the family's documents. uploaded_by (users.id) is the
-- author — it drives the rule-#1 teen redaction's parent-authored exemption exactly
-- as family_memory_episodes.authored_by does: a 13+ child's doc is visible ONLY to
-- its uploader. deleted_at is a soft delete so the row the audit trail references
-- (rule #6, PIPEDA right-to-access) stays intact.
CREATE TABLE "child_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL,
	"child_id" uuid,
	"uploaded_by" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"storage_path" text NOT NULL,
	"mime" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "child_documents" ADD CONSTRAINT "child_documents_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "child_documents" ADD CONSTRAINT "child_documents_child_id_children_id_fk" FOREIGN KEY ("child_id") REFERENCES "public"."children"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "child_documents" ADD CONSTRAINT "child_documents_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- The list read scans (family_id, deleted_at) ordered by created_at, mirroring the
-- episodes soft-delete index (0026).
CREATE INDEX "child_documents_family_deleted_idx" ON "child_documents" USING btree ("family_id","deleted_at");--> statement-breakpoint
-- Deny-by-default for the PostgREST Data API roles, same posture as 0012. The app
-- connects as postgres (BYPASSRLS); Hale never uses the Data API. Rule #1 — and
-- these are the most sensitive rows in the schema.
ALTER TABLE "child_documents" ENABLE ROW LEVEL SECURITY;
