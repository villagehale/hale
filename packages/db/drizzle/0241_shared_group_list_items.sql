-- VIL-687: a multi-family group's shared list items, each with an owner.
--
-- One row per thing on a list in ONE shared Linq chat (chat_id). Not a family's row:
-- several families share the chat. People are linq_shared_group_people rows, so a guest
-- can own an item, and no name is copied here.
--
-- owner_person_id null = still open. An item someone added goes when their presence row
-- is forgotten (ON DELETE cascade), unless someone staying claimed it: code passes it to
-- them first. An owner who is forgotten only frees it (set null).
-- hidden_for_kid, hidden_from_person_ids and hidden_from_family_ids mark a gift that is
-- never rendered to the child's family; code applies it on every read.
--
-- Additive. Re-runnable: IF NOT EXISTS throughout.
--
-- Reversible:
--   DROP TABLE IF EXISTS shared_group_list_items;
CREATE TABLE IF NOT EXISTS "shared_group_list_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chat_id" text NOT NULL,
	"list_name" text NOT NULL,
	"list_key" text NOT NULL,
	"text" text NOT NULL,
	"text_key" text NOT NULL,
	"added_by_person_id" uuid NOT NULL REFERENCES "linq_shared_group_people"("id") ON DELETE cascade,
	"owner_person_id" uuid REFERENCES "linq_shared_group_people"("id") ON DELETE set null,
	"claimed_at" timestamp with time zone,
	"hidden_for_kid" text,
	"hidden_from_person_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"hidden_from_family_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shared_group_list_items_list_name_length_check" CHECK (char_length("list_name") BETWEEN 1 AND 200),
	CONSTRAINT "shared_group_list_items_list_key_length_check" CHECK (char_length("list_key") >= 1),
	CONSTRAINT "shared_group_list_items_text_length_check" CHECK (char_length("text") BETWEEN 1 AND 500),
	CONSTRAINT "shared_group_list_items_text_key_length_check" CHECK (char_length("text_key") >= 1),
	CONSTRAINT "shared_group_list_items_hidden_for_kid_length_check" CHECK ("hidden_for_kid" IS NULL OR char_length("hidden_for_kid") BETWEEN 1 AND 100)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "shared_group_list_items_item_uniq" ON "shared_group_list_items" ("chat_id","list_key","text_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shared_group_list_items_chat_idx" ON "shared_group_list_items" ("chat_id","added_at");--> statement-breakpoint
ALTER TABLE "shared_group_list_items" ENABLE ROW LEVEL SECURITY;
