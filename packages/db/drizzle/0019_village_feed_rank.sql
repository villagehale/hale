-- Materialized agent-ranked feed order (additive only, rule #9).
-- One row per family holding the rank-recommendations agent's decided order.
-- The agent (~25s) now runs in the BACKGROUND on the write events that change
-- the candidate set and stores the order here, so the home feed read is a pure
-- DB lookup — the model never runs in the request path. ordered_ids carries no
-- precise location, only candidate ids (rule #1). family_id ON DELETE cascade so
-- a removed family can never leave a stale order behind.
CREATE TABLE "village_feed_rank" (
	"family_id" uuid PRIMARY KEY NOT NULL,
	"ordered_ids" jsonb NOT NULL,
	"fingerprint" text NOT NULL,
	"model_used" text NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "village_feed_rank" ADD CONSTRAINT "village_feed_rank_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Deny-by-default for the PostgREST Data API roles, same posture as 0012/0016.
-- The app connects as postgres (BYPASSRLS); Hale never uses the Data API. Rule #1.
ALTER TABLE "village_feed_rank" ENABLE ROW LEVEL SECURITY;
