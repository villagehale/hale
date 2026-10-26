-- VIL-447 (T23): shared lists in a family group (groceries, packing).
--
-- group_lists: one row per list, scoped to ONE group thread (conversation_id), so a list
-- is never read outside the group it was made in. group_list_items: what someone in the
-- group added, who added it, and who checked it off. Names are read from users at read
-- time; nothing here copies a name. No size cap.
--
-- Additive. Re-runnable: IF NOT EXISTS throughout.
-- NOT RUN against any shared or prod DB. Needs Sloane, then Barton, before prod.
--
-- Reversible:
--   DROP TABLE IF EXISTS group_list_items;
--   DROP TABLE IF EXISTS group_lists;
CREATE TABLE IF NOT EXISTS "group_lists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL REFERENCES "families"("id") ON DELETE cascade,
	"conversation_id" uuid NOT NULL REFERENCES "conversations"("id") ON DELETE cascade,
	"name" text NOT NULL,
	"created_by_user_id" uuid REFERENCES "users"("id") ON DELETE set null,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "group_lists_name_length_check" CHECK (char_length("name") BETWEEN 1 AND 200)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "group_lists_live_name_uniq" ON "group_lists" ("conversation_id", lower("name")) WHERE "archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "group_lists_conversation_idx" ON "group_lists" ("conversation_id");--> statement-breakpoint
ALTER TABLE "group_lists" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "group_list_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"list_id" uuid NOT NULL REFERENCES "group_lists"("id") ON DELETE cascade,
	"text" text NOT NULL,
	"text_key" text NOT NULL,
	"added_by_user_id" uuid REFERENCES "users"("id") ON DELETE set null,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"checked_at" timestamp with time zone,
	"checked_by_user_id" uuid REFERENCES "users"("id") ON DELETE set null,
	CONSTRAINT "group_list_items_text_length_check" CHECK (char_length("text") BETWEEN 1 AND 500)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "group_list_items_open_key_uniq" ON "group_list_items" ("list_id","text_key") WHERE "checked_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "group_list_items_list_idx" ON "group_list_items" ("list_id","checked_at");--> statement-breakpoint
ALTER TABLE "group_list_items" ENABLE ROW LEVEL SECURITY;
