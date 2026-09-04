-- Dead-man switch last-ran ledger (audit P1-8). The watchdog layer (drain,
-- triage, sweeps, digests) runs on the same Vercel cron substrate it monitors,
-- so "crons stopped" silences its own alarm. This table is the evidence of
-- life: one row per cron name, advanced by the shared cronRoute wrapper when a
-- handler completes. /api/health/crons compares each row's age against the
-- cadence in vercel.json, and an OFF-VERCEL checker (GitHub Actions) reads that
-- endpoint. Additive only (rule #9): one new table, nothing existing altered.
--
-- No seed rows on purpose: a cron the ledger has never seen is ARMED by the
-- health endpoint on first sight (insert now()), which starts its clock without
-- a week of false pages for the weekly crons after this ships.
CREATE TABLE IF NOT EXISTS "cron_heartbeats" (
	"name" text PRIMARY KEY NOT NULL,
	"last_ran_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

-- Deny-by-default for the PostgREST Data API roles, same posture as every
-- table (rule #1 — nothing here is PII, cron names and timestamps, but the
-- posture is uniform). The app connects as postgres (BYPASSRLS).
ALTER TABLE "cron_heartbeats" ENABLE ROW LEVEL SECURITY;
