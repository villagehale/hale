-- VIL-715. What a registration ask showed the parent, and what their yes bound.
-- One row per offer. The run compares its cart with `approved` before any charge.
-- Program facts, ids and cents only: never a child's name, birth date or age, a
-- postal code, or a card.
--
-- Additive and re-runnable. Reversible: DROP TABLE IF EXISTS authorized_signup_terms;

CREATE TABLE IF NOT EXISTS "authorized_signup_terms" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "offer_id" uuid NOT NULL REFERENCES "authorized_signup_offers"("id") ON DELETE cascade,
  "family_id" uuid NOT NULL REFERENCES "families"("id") ON DELETE cascade,
  "child_id" uuid NOT NULL REFERENCES "children"("id") ON DELETE cascade,
  "parent_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "shown" jsonb NOT NULL,
  "approved" jsonb,
  "approving_message_id" text,
  "asked_message_id" uuid REFERENCES "channel_messages"("id") ON DELETE set null,
  "approved_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "authorized_signup_terms_approved_check" CHECK (
    ("approved" IS NULL) = ("approved_at" IS NULL)
    AND ("approved" IS NULL) = ("approving_message_id" IS NULL)
  )
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "authorized_signup_terms_offer_uniq"
  ON "authorized_signup_terms" ("offer_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "authorized_signup_terms_family_idx"
  ON "authorized_signup_terms" ("family_id", "created_at");--> statement-breakpoint
ALTER TABLE "authorized_signup_terms" ENABLE ROW LEVEL SECURITY;
