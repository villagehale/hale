-- Group onboarding v2 — a roster member's number can be released and its blind index kept.
--
-- The retention sweep (apps/web/lib/channel/linq/roster-retention.ts) nulls
-- phone_e164_encrypted for members who said no, are not family, left, were removed or
-- were refused, once they have sat that way past the retention window. The hash stays,
-- so the same phone is still recognised on a re-add and the live-unique index holds.
--
-- Apply with 0158, before LINQ_GROUP_ONBOARDING_V2_ENABLED goes on. The retention
-- UPDATE sets this column null; against 0158's NOT NULL it throws inside delete-sweep.
--
-- Additive (rule #9): relaxes a NOT NULL, nothing is dropped. Re-runnable: DROP NOT NULL
-- on a nullable column is a no-op. Reversible (only once no row holds a null):
--   ALTER TABLE linq_group_roster_members ALTER COLUMN phone_e164_encrypted SET NOT NULL;

ALTER TABLE "linq_group_roster_members" ALTER COLUMN "phone_e164_encrypted" DROP NOT NULL;
