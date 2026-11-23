-- VIL-728 · the group loop guard's per-chat state. One row per Linq group chat while a run
-- of unverified-sender messages is open; a verified person speaking deletes it. The chat id
-- and two clocks only: no phone number, name, message text or family id (rule #1).
-- Additive (rule #9). New table only. Re-runnable: IF NOT EXISTS. Reversible:
--   DROP TABLE IF EXISTS linq_group_loop_guards;

CREATE TABLE IF NOT EXISTS "linq_group_loop_guards" (
	"chat_id" text PRIMARY KEY NOT NULL,
	"run_started_at" timestamp with time zone NOT NULL,
	"quiet_since" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "linq_group_loop_guards" ENABLE ROW LEVEL SECURITY;
