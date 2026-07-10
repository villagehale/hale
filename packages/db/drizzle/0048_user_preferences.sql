-- Per-user display preferences on the existing `users` row (additive only, rule #9).
-- `units` is DISPLAY-only: measurements are ALWAYS stored in metric (kg/cm) — this
-- column never changes storage, only how the web/app renders a growth reading
-- (metric = kg/cm, imperial = lb/in). `week_start_day` reorders the client-side
-- plan-spine columns (0=Sunday, 1=Monday), enforced at the app boundary — no CHECK
-- so the migration stays additive. Both live next to locale/timezone rather than in
-- a separate table. No RLS change needed (users already carries its policy).
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "units" text DEFAULT 'metric' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "week_start_day" smallint DEFAULT 1 NOT NULL;
