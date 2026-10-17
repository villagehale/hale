-- Keep household-owned history IDs; retired catalogs must not cascade-delete records.
ALTER TABLE "village_intro_proposals" DROP CONSTRAINT IF EXISTS "village_intro_proposals_civic_session_id_civic_sessions_id_fk";
--> statement-breakpoint
ALTER TABLE "watched_sources" DROP CONSTRAINT IF EXISTS "watched_sources_civic_venue_id_civic_venues_id_fk";
--> statement-breakpoint
DROP TABLE IF EXISTS "civic_sessions";
--> statement-breakpoint
DROP TABLE IF EXISTS "civic_venues";
