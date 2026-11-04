-- VIL-553 · one row per unread opt-out read, keyed by the provider's message id. A number
-- is held while any row for its phone_hash stands. next_read_at is the recovery claim and
-- its back-off. Additive (rule #9); opt_out_read_holds (0170) stays for older rows.
-- opt_out_read_holds.repointed_at: when a legacy row's placeable texts were held by
-- message. The row then stands only for the texts it could not place on its number.
CREATE TABLE IF NOT EXISTS "opt_out_held_messages" (
	"provider_message_id" text PRIMARY KEY NOT NULL,
	"phone_hash" text NOT NULL,
	"held_at" timestamp with time zone NOT NULL,
	"next_read_at" timestamp with time zone NOT NULL,
	"read_attempts" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "opt_out_held_messages_phone_idx" ON "opt_out_held_messages" ("phone_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "opt_out_held_messages_next_read_idx" ON "opt_out_held_messages" ("next_read_at");
--> statement-breakpoint
-- Server-only (no app policy): RLS on, like every table since the frozen legacy list.
ALTER TABLE "opt_out_held_messages" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "opt_out_read_holds" ADD COLUMN IF NOT EXISTS "repointed_at" timestamp with time zone;
