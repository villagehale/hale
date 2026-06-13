-- B18 entitlements migration. ADDITIVE ONLY (hard rule #9): one new enum type
-- and one NOT NULL column with a default. No drops, no type changes, no
-- narrowing. Safe to apply to a populated production database — every existing
-- families row backfills to 'free' (the most-restrictive default).
--
-- Hand-authored (drizzle-kit generate is broken in this repo — see
-- 0000_b8910_reliability.sql for the same pattern).

-- New billing tier enum. CREATE TYPE has no IF NOT EXISTS, so guard it.
DO $$ BEGIN
	CREATE TYPE "plan_tier" AS ENUM ('free', 'plus', 'family');
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

-- Family-level plan. NOT NULL with a 'free' default: existing rows backfill to
-- 'free' atomically, so the column is enforceable without a separate backfill
-- pass. Gates autonomous EXECUTION only (observe/draft stays free).
ALTER TABLE "families" ADD COLUMN IF NOT EXISTS "plan_tier" "plan_tier" DEFAULT 'free' NOT NULL;
