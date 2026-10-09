-- VIL-106 — a kid's interest passport. Additive (rule #9).
-- Reversible: DROP TABLE IF EXISTS interest_next_step_offers, kid_passport_profiles,
-- family_interest_settings, kid_interests;
-- Re-runnable: CREATE TABLE / INDEX use IF NOT EXISTS. CHECKs live inside CREATE
-- TABLE so a second pass skips them. RLS with no policy denies the anon Data API;
-- the app connects as postgres (BYPASSRLS).
--
-- What this table may hold (rule #1, and the 12-month message retention). A short
-- subject snippet and a source ref. Never an email body, never a snippet, never
-- quote evidence. The family cascade is the erasure path.
CREATE TABLE IF NOT EXISTS "kid_interests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "family_id" uuid NOT NULL REFERENCES "families"("id") ON DELETE cascade,
  "child_id" uuid REFERENCES "children"("id") ON DELETE cascade,
  "activity" text NOT NULL,
  "activity_key" text NOT NULL,
  "level" text,
  "season_key" text NOT NULL,
  "season_label" text NOT NULL,
  "kind" text NOT NULL,
  "state" text NOT NULL,
  "edited" boolean NOT NULL DEFAULT false,
  "shared" boolean NOT NULL DEFAULT false,
  "source_type" text NOT NULL,
  "source_ref" text NOT NULL,
  "source_subject" text,
  "source_seen_on" date,
  "source_owner_user_id" uuid REFERENCES "users"("id") ON DELETE set null,
  "sharer_first_name" text,
  "when_label" text,
  "session_start" date,
  "session_end" date,
  "weeks_total" integer,
  "weeks_elapsed" integer NOT NULL DEFAULT 0,
  "completed_at" timestamp with time zone,
  "first_seen" timestamp with time zone NOT NULL DEFAULT now(),
  "confirmed_at" timestamp with time zone,
  "removed_at" timestamp with time zone,
  "asked_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "kid_interests_activity_chk" CHECK (
    char_length("activity") BETWEEN 1 AND 80
    AND "activity" = btrim("activity")
    AND position(E'\n' IN "activity") = 0
  ),
  CONSTRAINT "kid_interests_activity_key_chk" CHECK (
    char_length("activity_key") BETWEEN 1 AND 80
    AND "activity_key" = btrim("activity_key")
    AND position(E'\n' IN "activity_key") = 0
  ),
  CONSTRAINT "kid_interests_level_chk" CHECK (
    "level" IS NULL OR (
      char_length("level") BETWEEN 1 AND 40
      AND "level" = btrim("level")
      AND position(E'\n' IN "level") = 0
    )
  ),
  CONSTRAINT "kid_interests_season_chk" CHECK (
    char_length("season_key") BETWEEN 1 AND 40
    AND char_length("season_label") BETWEEN 1 AND 40
    AND position(E'\n' IN "season_key") = 0
    AND position(E'\n' IN "season_label") = 0
  ),
  CONSTRAINT "kid_interests_kind_chk" CHECK ("kind" IN ('activity', 'outing')),
  CONSTRAINT "kid_interests_state_chk" CHECK ("state" IN ('inferred', 'confirmed', 'removed')),
  CONSTRAINT "kid_interests_source_type_chk" CHECK (
    "source_type" IN ('gmail', 'calendar', 'parent', 'group_share')
  ),
  CONSTRAINT "kid_interests_source_ref_chk" CHECK (
    char_length("source_ref") BETWEEN 1 AND 200
    AND "source_ref" = btrim("source_ref")
    AND position(E'\n' IN "source_ref") = 0
  ),
  CONSTRAINT "kid_interests_subject_chk" CHECK (
    "source_subject" IS NULL OR (
      char_length("source_subject") BETWEEN 1 AND 180
      AND position(E'\n' IN "source_subject") = 0
    )
  ),
  CONSTRAINT "kid_interests_sharer_chk" CHECK (
    "sharer_first_name" IS NULL OR (
      char_length("sharer_first_name") BETWEEN 1 AND 40
      AND position(E'\n' IN "sharer_first_name") = 0
    )
  ),
  CONSTRAINT "kid_interests_when_chk" CHECK (
    "when_label" IS NULL OR (
      char_length("when_label") BETWEEN 1 AND 80
      AND position(E'\n' IN "when_label") = 0
    )
  ),
  CONSTRAINT "kid_interests_weeks_chk" CHECK (
    ("weeks_total" IS NULL OR "weeks_total" BETWEEN 1 AND 60)
    AND "weeks_elapsed" >= 0
    AND ("weeks_total" IS NULL OR "weeks_elapsed" <= "weeks_total")
  )
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "kid_interests_live_uniq"
  ON "kid_interests" ("child_id", "activity_key", "season_key")
  WHERE "state" <> 'removed' AND "child_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "kid_interests_child_source_uniq"
  ON "kid_interests" ("child_id", "source_ref")
  WHERE "child_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "kid_interests_unassigned_source_uniq"
  ON "kid_interests" ("family_id", "source_ref")
  WHERE "child_id" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "kid_interests_family_idx"
  ON "kid_interests" ("family_id");--> statement-breakpoint
ALTER TABLE "kid_interests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "family_interest_settings" (
  "family_id" uuid PRIMARY KEY REFERENCES "families"("id") ON DELETE cascade,
  "share_with_group" boolean NOT NULL DEFAULT false,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);--> statement-breakpoint
ALTER TABLE "family_interest_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "interest_next_step_offers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "family_id" uuid NOT NULL REFERENCES "families"("id") ON DELETE cascade,
  "child_id" uuid NOT NULL REFERENCES "children"("id") ON DELETE cascade,
  "season_key" text NOT NULL,
  "offered_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "interest_next_step_season_chk" CHECK (
    char_length("season_key") BETWEEN 1 AND 40
    AND position(E'\n' IN "season_key") = 0
  )
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "interest_next_step_offers_child_season_uniq"
  ON "interest_next_step_offers" ("child_id", "season_key");--> statement-breakpoint
ALTER TABLE "interest_next_step_offers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "kid_passport_profiles" (
  "child_id" uuid PRIMARY KEY REFERENCES "children"("id") ON DELETE cascade,
  "family_id" uuid NOT NULL REFERENCES "families"("id") ON DELETE cascade,
  "grade" text,
  "notes" text,
  "school_day_ends" text,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "kid_passport_profiles_grade_chk" CHECK (
    "grade" IS NULL OR (
      char_length("grade") BETWEEN 1 AND 40
      AND position(E'\n' IN "grade") = 0
    )
  ),
  CONSTRAINT "kid_passport_profiles_notes_chk" CHECK (
    "notes" IS NULL OR (
      char_length("notes") BETWEEN 1 AND 500
      AND position(E'\n' IN "notes") = 0
    )
  ),
  CONSTRAINT "kid_passport_profiles_ends_chk" CHECK (
    "school_day_ends" IS NULL OR (
      char_length("school_day_ends") BETWEEN 1 AND 40
      AND position(E'\n' IN "school_day_ends") = 0
    )
  )
);--> statement-breakpoint
ALTER TABLE "kid_passport_profiles" ENABLE ROW LEVEL SECURITY;
