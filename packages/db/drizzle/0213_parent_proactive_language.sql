-- VIL-572 · one stored language for everything Hale sends a parent unprompted.
-- `proactive_language` changes only when the parent asks for a language or texts in a
-- new one turn after turn; the streak columns count that run. Null means the parent has
-- set nothing yet, and readers fall back to families.primary_language.
-- Additive (rule #9). Three columns, no rewrite. Re-runnable: IF NOT EXISTS. Reversible:
--   ALTER TABLE users DROP COLUMN IF EXISTS proactive_language,
--     DROP COLUMN IF EXISTS language_streak_tag, DROP COLUMN IF EXISTS language_streak_count;

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "proactive_language" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "language_streak_tag" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "language_streak_count" integer DEFAULT 0 NOT NULL;
