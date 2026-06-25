-- Village map: PUBLIC venue coordinates for the list↔map companion view.
-- Additive only (rule #9): four nullable columns on village_candidates. These
-- hold a PUBLIC place's location (a YMCA, a library) resolved from the
-- candidate's title + the family's COARSE area — never the family's location
-- (rule #1). Online / no-venue activities and geocode misses stay null
-- (list-only, no pin). RLS already enabled on this table (0012/0016).
ALTER TABLE "village_candidates" ADD COLUMN "lat" double precision;--> statement-breakpoint
ALTER TABLE "village_candidates" ADD COLUMN "lng" double precision;--> statement-breakpoint
ALTER TABLE "village_candidates" ADD COLUMN "venue_name" text;--> statement-breakpoint
ALTER TABLE "village_candidates" ADD COLUMN "venue_address" text;
