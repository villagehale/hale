-- VIL-147 · the teen raw-access grant the privacy page promises — one enum, one table.
-- Additive only (rule #9): nothing is dropped, no existing value changes meaning, and
-- the default behaviour of every existing read is unchanged (an empty table means no
-- grant matches, which is byte-for-byte today's redaction).
--
-- 'teen_access_scope' is its own type rather than reusing consent_type because the two
-- answer different questions and must be free to diverge: consent_type names WHICH
-- CONSENT was recorded (one value, 'teen_content_access', covers the whole feature),
-- while teen_access_scope names WHAT A GRANT UNLOCKS. Folding the scopes into
-- consent_type would make every new content class a new consent kind in the CASL/PIPEDA
-- ledger, misstating in a right-to-access export what the parent actually agreed to.
--
-- The table carries its own start/expiry rather than leaning on consent_records.expires_at
-- because a grant has FOUR states the ledger cannot express (requested, assented,
-- active, revoked) and the read path must distinguish them on every single read.
DO $$ BEGIN
 CREATE TYPE "public"."teen_access_scope" AS ENUM('message_content', 'calendar_detail', 'child_profile');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "teen_access_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL,
	"child_id" uuid NOT NULL,
	"granted_to_user_id" uuid NOT NULL,
	"scope" "teen_access_scope" NOT NULL,
	"reason" text NOT NULL,
	"safety_escalation" boolean DEFAULT false NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"teen_assent_at" timestamp with time zone,
	"starts_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"teen_notified_at" timestamp with time zone,
	"consent_record_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	-- The time-limit guarantee lives HERE, not only in a code review: an ACTIVE window
	-- is always a complete, forward-ordered pair. A half-set window would otherwise be
	-- readable as "started, never expires" — an unbounded standing grant, which is the
	-- one thing rule #1 forbids.
	CONSTRAINT "teen_access_grants_window_check" CHECK (
		("starts_at" IS NULL) = ("expires_at" IS NULL)
		AND ("starts_at" IS NULL OR "expires_at" > "starts_at")
	),
	-- Rule #5: teen assent is required to ACTIVATE, and the only way past it is the
	-- rule #1 safety escalation. Enforced in the store AND here, so no future writer
	-- can activate a grant a teen never assented to without declaring the exception.
	CONSTRAINT "teen_access_grants_assent_check" CHECK (
		"starts_at" IS NULL OR "teen_assent_at" IS NOT NULL OR "safety_escalation"
	)
);
--> statement-breakpoint
ALTER TABLE "teen_access_grants" ADD CONSTRAINT "teen_access_grants_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teen_access_grants" ADD CONSTRAINT "teen_access_grants_child_id_children_id_fk" FOREIGN KEY ("child_id") REFERENCES "public"."children"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teen_access_grants" ADD CONSTRAINT "teen_access_grants_granted_to_user_id_users_id_fk" FOREIGN KEY ("granted_to_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teen_access_grants" ADD CONSTRAINT "teen_access_grants_consent_record_id_consent_records_id_fk" FOREIGN KEY ("consent_record_id") REFERENCES "public"."consent_records"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "teen_access_grants_lookup_idx" ON "teen_access_grants" ("family_id","child_id","scope");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "teen_access_grants_family_idx" ON "teen_access_grants" ("family_id","requested_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "teen_access_grants_owed_notification_idx" ON "teen_access_grants" ("family_id") WHERE "teen_notified_at" IS NULL;
