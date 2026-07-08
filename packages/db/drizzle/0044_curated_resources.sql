-- curated_resources: a hand-verified, family-AGNOSTIC directory of public local
-- resources (EarlyON centres, public-library kids' programs, splash pads, public
-- health lines) surfaced as a calm "Resources" rail on the Village surface.
-- Additive only (rule #9).
--
-- Unlike village_candidates, these rows are NOT tied to a family — they are shared
-- reference data seeded from a verified list (never LLM-discovered, never
-- fabricated). There is no family_id and nothing here is PII (rule #1): a resource
-- is a public program's name, category, coarse service area, and outbound URL.
--
-- RLS is still ENABLED with no policy (deny-by-default for the PostgREST Data API
-- roles), matching every other table (0012/0042): Hale connects as postgres
-- (BYPASSRLS) and reads these server-side via the API, never through the Data API.
-- A permissive read policy would be WRONG here — no sibling table has one, and the
-- app never uses the anon/authenticated Data API roles.
--
-- (name, area) is UNIQUE so the seed is idempotent: a re-run upserts the same row
-- rather than duplicating it. sort_order lets the seed control the rail's ordering
-- without relying on insert order.
CREATE TABLE "curated_resources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"category" text NOT NULL,
	"area" text NOT NULL,
	"url" text NOT NULL,
	"description" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "curated_resources_name_area_idx" ON "curated_resources" USING btree ("name","area");--> statement-breakpoint
-- Deny-by-default for the PostgREST Data API roles, same posture as 0012/0042. The
-- app connects as postgres (BYPASSRLS) and reads these server-side. Rule #1.
ALTER TABLE "curated_resources" ENABLE ROW LEVEL SECURITY;
