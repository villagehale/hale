-- VIL-417. A soft guess at which parent is texting: mother, father, or unknown.
-- The onboarding model returns it with its structured capture, from the first
-- name and anything the parent said. Code validates the enum and stores it.
-- `parent_role_basis` says how it was reached: `stated` when the parent said so
-- ("I'm his dad"), `guessed` when it was read off a name. A guess never
-- overwrites a stated role. Parent-facing copy never states it as fact.
--
-- Additive, nullable, no default (rule #9): a row that predates the column has
-- no guess, which is the truth. Re-runnable: ADD COLUMN IF NOT EXISTS, and the
-- check constraints are inside a duplicate-object guard.
--
-- The checks are added NOT VALID and then validated in their own statements:
-- NOT VALID takes only a brief lock and applies to new writes at once, and
-- VALIDATE scans the table with a SHARE UPDATE EXCLUSIVE lock that does not
-- block reads or writes. The columns are new and null everywhere, so the
-- scan has nothing to reject.
--
-- Reversible:
--   ALTER TABLE users DROP CONSTRAINT IF EXISTS users_parent_role_check;
--   ALTER TABLE users DROP CONSTRAINT IF EXISTS users_parent_role_basis_check;
--   ALTER TABLE users
--     DROP COLUMN IF EXISTS parent_role,
--     DROP COLUMN IF EXISTS parent_role_basis;

ALTER TABLE "public"."users" ADD COLUMN IF NOT EXISTS "parent_role" text;--> statement-breakpoint
ALTER TABLE "public"."users" ADD COLUMN IF NOT EXISTS "parent_role_basis" text;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "public"."users"
    ADD CONSTRAINT "users_parent_role_check"
    CHECK ("parent_role" IS NULL OR "parent_role" IN ('mother', 'father', 'unknown'))
    NOT VALID;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "public"."users"
    ADD CONSTRAINT "users_parent_role_basis_check"
    CHECK ("parent_role_basis" IS NULL OR "parent_role_basis" IN ('stated', 'guessed'))
    NOT VALID;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

ALTER TABLE "public"."users" VALIDATE CONSTRAINT "users_parent_role_check";--> statement-breakpoint
ALTER TABLE "public"."users" VALIDATE CONSTRAINT "users_parent_role_basis_check";
