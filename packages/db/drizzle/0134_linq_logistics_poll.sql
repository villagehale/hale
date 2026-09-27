-- VIL-377 — logistics poll options remember what a vote means.
--
-- Additive only (rule #9). Existing year-find rows stay null and keep the
-- year-find vote path. Nothing is dropped and no existing value changes
-- meaning. Re-runnable: every statement is IF NOT EXISTS.
--
-- poll_kind: who_takes | both_free. Null means year-find.
-- subject_key: the family_memory_facts key the vote closes.
-- choice_kind: parent | figure_it_out | slot | none | find.
-- choice_value: parent user id, or the slot start instant. Null names nobody.
ALTER TABLE "linq_poll_options" ADD COLUMN IF NOT EXISTS "poll_kind" text;--> statement-breakpoint
ALTER TABLE "linq_poll_options" ADD COLUMN IF NOT EXISTS "subject_key" text;--> statement-breakpoint
ALTER TABLE "linq_poll_options" ADD COLUMN IF NOT EXISTS "choice_kind" text;--> statement-breakpoint
ALTER TABLE "linq_poll_options" ADD COLUMN IF NOT EXISTS "choice_value" text;
