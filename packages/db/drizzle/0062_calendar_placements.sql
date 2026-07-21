-- VIL-219 (B3) — calendar placements + ICS feed. Additive only (rule #9).
--
-- 'placement' family_event_source: a Hale-authored calendar placement (the
-- calendar_add executor), distinct from the three EXTERNAL-occasion sources. The
-- weekly-plan composer surfaces external occasions but NOT placements (a placed item
-- is a durable calendar entry, not a fresh proposal); the ICS feed renders both.
--
-- family_events.deleted_at: soft-delete for calendar_cancel — the placement's audit
-- trail + provenance survive (rules #6/#9) and an UNDO stays reversible. Every read
-- that surfaces a live event (composer window, ICS feed, reviewer conflict check)
-- filters deleted_at IS NULL.
--
-- families.ics_share_token: the tokenized, revocable secret for the family's READ-ONLY
-- ICS subscription feed. Public ICS reads resolve WHERE ics_share_token = :token, so
-- nulling it revokes the feed (same share-token pattern as villageCandidates /
-- routineProposals). Nullable + UNIQUE: many families with no feed (null), unique
-- non-null tokens.
--
-- Slot note: file 0062 (0061 is reserved for VIL-213, mid-build); the journal is 1:1
-- with the files, which is what the consistency gate checks.
ALTER TYPE "public"."family_event_source" ADD VALUE 'placement';--> statement-breakpoint
ALTER TABLE "family_events" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "families" ADD COLUMN "ics_share_token" text;--> statement-breakpoint
ALTER TABLE "families" ADD CONSTRAINT "families_ics_share_token_unique" UNIQUE("ics_share_token");
