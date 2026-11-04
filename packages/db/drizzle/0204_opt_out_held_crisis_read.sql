-- VIL-602 · what a held text was read as when it was read as a crisis: the language, and
-- the situation and who from their closed lists. On the held row, so it lives no longer
-- than the text it describes: a release deletes the row, an erasure clears it. Additive
-- (rule #9), nullable: a text never read as a crisis has none.
ALTER TABLE "opt_out_held_messages" ADD COLUMN IF NOT EXISTS "crisis_language" text;
--> statement-breakpoint
ALTER TABLE "opt_out_held_messages" ADD COLUMN IF NOT EXISTS "crisis_situation" text;
--> statement-breakpoint
ALTER TABLE "opt_out_held_messages" ADD COLUMN IF NOT EXISTS "crisis_who" text;
