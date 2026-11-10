-- Retain family-owned receipts and relationships, not the discovery catalog.
DO $$ BEGIN
SET LOCAL lock_timeout = '5s';
IF to_regclass('public.village_candidates') IS NOT NULL THEN
CREATE TABLE IF NOT EXISTS "family_activity_history" (LIKE "village_candidates" INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES);
ALTER TABLE "family_activity_history" ADD COLUMN IF NOT EXISTS "offered_at" timestamp with time zone;
INSERT INTO "family_activity_history"
SELECT c.*, NULL::timestamp with time zone
FROM "village_candidates" c
WHERE c.share_token IS NOT NULL
   OR EXISTS (SELECT 1 FROM "village_saves" s WHERE s.candidate_id = c.id)
   OR EXISTS (SELECT 1 FROM "village_endorsements" e WHERE e.candidate_id = c.id)
   OR EXISTS (SELECT 1 FROM "events" e WHERE e.family_id = c.family_id AND e.payload ->> 'candidate_id' = c.id::text)
   OR EXISTS (SELECT 1 FROM "actions" a WHERE a.family_id = c.family_id AND a.payload -> 'sourceRef' ->> 'table' = 'village_candidates' AND a.payload -> 'sourceRef' ->> 'id' = c.id::text)
   OR EXISTS (SELECT 1 FROM "authorized_signup_offers" o WHERE o.family_id = c.family_id AND o.activity_key = c.id::text)
   OR EXISTS (SELECT 1 FROM "activity_reviews" r WHERE r.family_id = c.family_id AND ((r.subject_source = 'place' AND r.subject_ref = c.place_id) OR (r.subject_source = 'civic_venue' AND r.subject_ref = c.civic_venue_id::text)))
   OR EXISTS (SELECT 1 FROM "week_plans" p WHERE p.family_id = c.family_id AND EXISTS (SELECT 1 FROM jsonb_array_elements(p.items) item WHERE item -> 'sourceRef' ->> 'table' = 'village_candidates' AND item -> 'sourceRef' ->> 'id' = c.id::text));
ALTER TABLE "family_activity_history" ADD CONSTRAINT "family_activity_history_family_id_families_id_fk" FOREIGN KEY ("family_id") REFERENCES "families"("id") ON DELETE cascade;
ALTER TABLE "family_activity_history" ADD CONSTRAINT "family_activity_history_child_id_children_id_fk" FOREIGN KEY ("child_id") REFERENCES "children"("id") ON DELETE set null;
ALTER TABLE "family_activity_history" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "village_saves" DROP CONSTRAINT "village_saves_candidate_id_village_candidates_id_fk";
ALTER TABLE "village_saves" ADD CONSTRAINT "village_saves_candidate_id_family_activity_history_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "family_activity_history"("id") ON DELETE cascade;
ALTER TABLE "village_endorsements" DROP CONSTRAINT "village_endorsements_candidate_id_village_candidates_id_fk";
ALTER TABLE "village_endorsements" ADD CONSTRAINT "village_endorsements_candidate_id_family_activity_history_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "family_activity_history"("id") ON DELETE cascade;
DROP TABLE IF EXISTS "village_feed_rank";
DROP TABLE "village_candidates";

END IF;
END $$;
