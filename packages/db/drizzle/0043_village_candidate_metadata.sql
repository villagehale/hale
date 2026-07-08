-- Village candidate metadata: honest, presence-gated card attributes. Additive
-- only (rule #9): six nullable columns on village_candidates, no destructive
-- edits. RLS already enabled on this table (0012/0016). Every one of these is
-- NULL by default and rendered ONLY when a real value is present — nothing is
-- ever fabricated (no stars for a null rating, no chip for a null attribute).
--   1. rating        — the venue's public Google rating (0.0–5.0), enriched from
--      Places at discovery time. NULL when Places has no rating or the API is
--      not enabled (the enrichment degrades to null). Verified data only.
--   2. rating_count  — how many ratings that average rests on, so the card can
--      show "4.6 (128)". NULL alongside a null rating.
--   3. price_level   — a coarse price band the model may honestly emit
--      ('free' | 'low' | 'moderate' | 'high') or NULL. Free text, not an enum,
--      so a new band lands without a migration; the card maps it to a label.
--   4. age_range     — a human age hint the model may emit ("3–5 years") or NULL.
--   5. indoor_outdoor — 'indoor' | 'outdoor' | 'both' or NULL. Free text.
--   6. place_id      — the Google Places id captured during enrichment, so a
--      future re-enrichment can look the venue up by id (stable) rather than by
--      a re-geocode. NULL for online / no-venue / un-enriched rows.
ALTER TABLE "village_candidates" ADD COLUMN "rating" numeric(2, 1);--> statement-breakpoint
ALTER TABLE "village_candidates" ADD COLUMN "rating_count" integer;--> statement-breakpoint
ALTER TABLE "village_candidates" ADD COLUMN "price_level" text;--> statement-breakpoint
ALTER TABLE "village_candidates" ADD COLUMN "age_range" text;--> statement-breakpoint
ALTER TABLE "village_candidates" ADD COLUMN "indoor_outdoor" text;--> statement-breakpoint
ALTER TABLE "village_candidates" ADD COLUMN "place_id" text;
