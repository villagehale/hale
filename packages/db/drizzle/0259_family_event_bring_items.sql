-- VIL-720 · what an email or flyer says to bring, against the event it is for.
--
-- One row per source per parent: the email a parent's own Gmail carried, or the flyer the
-- parent sent Hale 1:1 for an event the coach offered to add. `owner_user_id` is that
-- parent, and the ONLY reader (the 1:1 reminder) shows a row to its owner alone, so one
-- parent's inbox never reaches the co-parent, a caregiver or a group (group privacy).
--
-- `event_id` is null while the source's occasion is not on the calendar yet: the parent was
-- asked whether to add it. Their yes sets it (`attached_at`); their no deletes the row.
-- `source_ref` is `<integration id>:<message id>`, the same pair as that offer row.
--
-- It holds the extracted items only (a JSON array of strings), never the email, the
-- flyer or a quote of either (rule #1). Erasure is the cascade from the family, the parent
-- or the event.
--
-- Additive (rule #9). New table only. Re-runnable: IF NOT EXISTS throughout. Reversible:
--   DROP TABLE IF EXISTS family_event_bring_items;
CREATE TABLE IF NOT EXISTS "family_event_bring_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL REFERENCES "families"("id") ON DELETE cascade,
	"owner_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
	"event_id" uuid REFERENCES "family_events"("id") ON DELETE cascade,
	"source_kind" text NOT NULL,
	"source_ref" text NOT NULL,
	"items" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL DEFAULT now(),
	"attached_at" timestamp with time zone,
	CONSTRAINT "family_event_bring_items_source_kind_check" CHECK ("source_kind" IN ('email', 'photo')),
	CONSTRAINT "family_event_bring_items_items_array_check" CHECK (jsonb_typeof("items") = 'array'),
	CONSTRAINT "family_event_bring_items_attached_check" CHECK (("event_id" IS NULL) OR ("attached_at" IS NOT NULL))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "family_event_bring_items_owner_source_uniq" ON "family_event_bring_items" ("owner_user_id","source_ref");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "family_event_bring_items_event_owner_idx" ON "family_event_bring_items" ("event_id","owner_user_id") WHERE "event_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "family_event_bring_items_pending_idx" ON "family_event_bring_items" ("owner_user_id","created_at") WHERE "event_id" IS NULL;--> statement-breakpoint
ALTER TABLE "family_event_bring_items" ENABLE ROW LEVEL SECURITY;
