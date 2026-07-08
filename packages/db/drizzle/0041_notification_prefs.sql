-- Per-user push notification preferences + a per-family push-send ledger (additive
-- only, rule #9). notification_prefs holds the two push streams a parent controls
-- (new village picks, health reminders), both default TRUE (a push is a
-- transactional, in-app family signal — not CASL commercial email — so the default
-- is on, and a parent turns a stream off here). The daily brief EMAIL stays on its
-- existing opt-out model (email_opt_outs); it is deliberately NOT duplicated here.
--
-- push_sends is the once-per-family-per-day debounce ledger: one row per fired
-- push, keyed by (family, kind). The send path checks "did this family already get
-- a push of this kind today?" against this ledger before addressing any device —
-- cheaper and more honest than scanning the append-only audit_log. The audit_log
-- row (rule #6) still records each send (category + child-id reference, never the
-- body text); this ledger is only the debounce source of truth. Both cascade on
-- the user/family so a deleted account leaves nothing behind (rule #1).
CREATE TABLE "notification_prefs" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"push_new_picks" boolean DEFAULT true NOT NULL,
	"push_health_reminders" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "push_sends" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notification_prefs" ADD CONSTRAINT "notification_prefs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_sends" ADD CONSTRAINT "push_sends_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "push_sends_family_kind_time_idx" ON "push_sends" USING btree ("family_id","kind","sent_at");--> statement-breakpoint
-- Deny-by-default for the PostgREST Data API roles, same posture as 0020/0040.
-- The app connects as postgres (BYPASSRLS); Hale never uses the Data API. Rule #1.
ALTER TABLE "notification_prefs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "push_sends" ENABLE ROW LEVEL SECURITY;
