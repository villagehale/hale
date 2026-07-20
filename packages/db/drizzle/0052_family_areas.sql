-- family_areas: a family's SAVED coarse areas for village discovery — the switcher
-- behind the Village header ("home", "grandma's"). Additive only (rule #9) over the
-- single stored area on `families`. Exactly one row is active per family (the partial
-- unique index below); village content derives from the active row, falling back to
-- the legacy families location fields when a family has no rows.
--
-- Privacy (rule #1): COARSE by construction — city / province / postal only. There is
-- deliberately NO latitude/longitude column: the server never accepts or stores precise
-- coordinates (the client resolves "use my current location" to a coarse {city,
-- province} on-device and saves only that).
CREATE TABLE "family_areas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL,
	"city" text NOT NULL,
	"province" text,
	"note" text,
	"postal_code" text,
	"is_active" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "family_areas" ADD CONSTRAINT "family_areas_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "family_areas_family_idx" ON "family_areas" USING btree ("family_id");--> statement-breakpoint
-- At most one ACTIVE area per family — makes "exactly one active" true by construction
-- (rule #6). Partial (is_active) so inactive rows are unconstrained.
CREATE UNIQUE INDEX "family_areas_family_active_idx" ON "family_areas" USING btree ("family_id") WHERE "is_active";--> statement-breakpoint
-- Deny-by-default for the PostgREST Data API roles, same posture as 0040. The app
-- connects as postgres (BYPASSRLS); Hale never uses the Data API. Rule #1.
ALTER TABLE "family_areas" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- Backfill: seed one ACTIVE area per family from its existing stored location, so a
-- family that set a location before this table keeps identical village content (the
-- active row derives the SAME coarse area the legacy families.area_coarse did). Only
-- families with a city are seeded (city is NOT NULL here); a family with no stored city
-- gets no row and falls back to the legacy fields until it saves one.
INSERT INTO "family_areas" ("family_id", "city", "province", "postal_code", "is_active")
SELECT "id", "city", "province", "postal_code", true
FROM "families"
WHERE "city" IS NOT NULL;
