-- Drop the retired civic event catalog (Barton, 2026-10-25: "删掉").
--
-- #876 (VIL-423) moved every recommendation read to live web search; nothing reads
-- civic_sessions or civic_venues any more. This drops both tables and the two nullable
-- FK columns that pointed at them. registration_windows is untouched.
-- family_activity_history.civic_venue_id stays: it is a plain uuid with no FK (0123),
-- used as an opaque review-subject id.
ALTER TABLE "village_intro_proposals" DROP CONSTRAINT IF EXISTS "village_intro_proposals_civic_session_id_civic_sessions_id_fk";--> statement-breakpoint
ALTER TABLE "village_intro_proposals" DROP COLUMN IF EXISTS "civic_session_id";--> statement-breakpoint
ALTER TABLE "watched_sources" DROP CONSTRAINT IF EXISTS "watched_sources_civic_venue_id_civic_venues_id_fk";--> statement-breakpoint
ALTER TABLE "watched_sources" DROP COLUMN IF EXISTS "civic_venue_id";--> statement-breakpoint
DROP TABLE IF EXISTS "civic_sessions";--> statement-breakpoint
DROP TABLE IF EXISTS "civic_venues";
