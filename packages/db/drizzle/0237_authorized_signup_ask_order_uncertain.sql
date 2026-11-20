-- A bare yes or no answers the sign-up ask whose text reached the parent last
-- (authorized_signup_offers.last_asked_seq, 0236). The number is drawn when a send about
-- an ask starts and kept on the offer once the transport took the text. When keeping it
-- fails after the text went (the UPDATE fails twice), the order on file is wrong: an older
-- ask would take the bare answer to the text the parent just got. One row here per family
-- and parent says so, and while it stands no bare answer binds any of that parent's asks;
-- the coach asks which one. A later kept number drawn after failed_seq removes it.
-- failures counts how often that happened before one was kept: ops is paged on a repeat.
-- A number and a count only: never a person, a message body or a link. The family and
-- user cascades are erasure.
-- Additive (rule #9). Re-runnable: IF NOT EXISTS. RLS with no policy denies the anon Data
-- API; the app connects as postgres (BYPASSRLS). Reversible:
--   DROP TABLE IF EXISTS authorized_signup_ask_order_uncertain;
CREATE TABLE IF NOT EXISTS "authorized_signup_ask_order_uncertain" (
	"family_id" uuid NOT NULL REFERENCES "families"("id") ON DELETE cascade,
	"parent_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
	"failed_seq" bigint NOT NULL,
	"failures" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	PRIMARY KEY ("family_id", "parent_user_id")
);--> statement-breakpoint
ALTER TABLE "authorized_signup_ask_order_uncertain" ENABLE ROW LEVEL SECURITY;
