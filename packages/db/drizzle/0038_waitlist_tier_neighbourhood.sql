-- Plus/Family waitlist capture (landing pricing): which tier a signup wants, a
-- coarse self-reported neighbourhood (never a precise address — rule #1), and
-- where the signup came from. Additive only (rule #9) on the existing waitlist
-- table (0007); RLS enabled since 0012. Tag skips 0037 — that number is taken by
-- the integrations branch (0037_integration_provider_gdrive, already on prod).
ALTER TABLE "waitlist" ADD COLUMN "neighbourhood" text;--> statement-breakpoint
ALTER TABLE "waitlist" ADD COLUMN "tier" text;--> statement-breakpoint
ALTER TABLE "waitlist" ADD COLUMN "source" text;
