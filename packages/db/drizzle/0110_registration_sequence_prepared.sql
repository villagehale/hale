-- VIL-338 · PREPARED REGISTRATION, RUNG 1. Three additive nullable columns on a table
-- that already exists, one paired CHECK, and RLS turned on for it. No new table, no
-- ALTER TYPE, no index: with every column NULL this migration is byte-for-byte today's
-- behaviour (rule #9).
--
-- WHY COLUMNS AND NOT A TABLE. The schema file for this table says what is deliberately
-- absent from it — no status column, because consent lives on the approval spine; no
-- per-leg rows, because every leg time is a pure function of the live window row — and
-- then says what IS here: the state nothing else can derive. The course a parent chose,
-- the clock that course opens on for this family, and what they told Hale about their
-- own portal setup are exactly that: answers only this (family, window) pair can give,
-- read on the same tick the legs are, dead with the sequence.
--
-- ONE PAGE-DERIVED VALUE IS STORED, and it is the anchor. A bound ladder's legs are a
-- pure function of course_opens_at, the way an unbound ladder's are of the window row;
-- the scheduler cannot re-read the page 288 times a day, and the course page is the
-- municipality's own system of record for that course. It is written from a fresh read,
-- refreshed by every later read, and the text prints it only after the read of the same
-- tick agrees with it. Nothing else the page says is stored.
--
-- CREDENTIAL-FREE BY CONSTRUCTION (rule #1). There is deliberately no column here for a
-- password, a session cookie, an antiforgery token, a cart id or a portal account id,
-- and no code in this feature could fill one. The only thing Hale sends to the
-- municipality is a bare Accept-only GET of the course page in course_url.
--
-- ERASURE is unchanged: the row cascades from families, so the deletion sweep's single
-- DELETE FROM families collects the course link and the readiness answer with everything
-- else (rule #1, PIPEDA).

ALTER TABLE "public"."registration_sequences"
  ADD COLUMN IF NOT EXISTS "course_url" text;
--> statement-breakpoint

ALTER TABLE "public"."registration_sequences"
  ADD COLUMN IF NOT EXISTS "course_opens_at" timestamp with time zone;
--> statement-breakpoint

ALTER TABLE "public"."registration_sequences"
  ADD COLUMN IF NOT EXISTS "readiness_ready" boolean;
--> statement-breakpoint

-- A bound course has the clock it opens on for this family, or it is not bound.
DO $$ BEGIN
  ALTER TABLE "public"."registration_sequences"
    ADD CONSTRAINT "registration_sequences_course_check"
    CHECK (("course_url" IS NULL) = ("course_opens_at" IS NULL));
EXCEPTION
  WHEN duplicate_object OR duplicate_table THEN null;
END $$;
--> statement-breakpoint

-- Deny-by-default for the PostgREST Data API roles, the posture every table created
-- since 2026-08-11 has. This table shipped before that date without it, and this
-- migration is the one that makes the row hold what a household is preparing for, so
-- the ratchet's own rule applies: fix it and delete its line from KNOWN_UNPROTECTED in
-- packages/db/scripts/migration-rls-consistency.test.mjs in the same PR. The app
-- connects as postgres (BYPASSRLS); nothing about the app's own reads changes.
ALTER TABLE "registration_sequences" ENABLE ROW LEVEL SECURITY;

-- BUILDER NOTES, each checked against packages/db/scripts this turn:
--  * ADD CONSTRAINT is wrapped in a DO block — the 0080_channel_message_unmet_intent
--    precedent — because Postgres 16 has no ADD CONSTRAINT IF NOT EXISTS. PRs #609/#610
--    made hand-applied migrations re-runnable; this file is re-runnable by the same
--    construction (ENABLE ROW LEVEL SECURITY is idempotent), and the faithful gate is
--    apps/web/lib/testing/migrations-rerunnable.pglite.test.ts, which applies it twice.
--  * ENABLE ROW LEVEL SECURITY is UNQUALIFIED on purpose: the ratchet's regex matches
--    only the unqualified form (migration-rls-consistency.test.mjs:36-40).
--  * migration-enum-consistency.test.mjs scans RAW sql (comments included) for a quoted
--    word, whitespace, then another quoted word (:34). Nothing above puts two
--    double-quoted words next to each other; every added column is followed by an
--    UNQUOTED type and the ALTER TABLE targets are dot-qualified or single.
