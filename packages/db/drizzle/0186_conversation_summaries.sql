-- VIL-144: running summary of a conversation's older turns (internal coach context).
-- NOT YET APPROVED FOR PROD: needs Sloane + Barton before it runs on any shared DB.
-- Reversible:
--   DROP TABLE IF EXISTS "conversation_summaries";
CREATE TABLE IF NOT EXISTS "conversation_summaries" (
  "conversation_id" uuid PRIMARY KEY NOT NULL REFERENCES "conversations"("id") ON DELETE cascade,
  "family_id" uuid NOT NULL REFERENCES "families"("id") ON DELETE cascade,
  "summary" text NOT NULL,
  "covered_turns" integer NOT NULL,
  "model" text NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
