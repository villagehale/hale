-- A family can hold several live signup asks, one pending per site (0230's index). A new
-- offer closes an earlier one only when the parent's own words replaced it, and a message
-- is read against the newest ask first. activity_label is the program's public name as the
-- page or the parent gave it, so a reader can tell a message about another activity from
-- one about this offer, words that name an older ask can reach it, and the coach can say
-- which ask a new one replaced. Never a child, a person or a link.
-- Additive (rule #9). Nullable, no default: rows from before read as unnamed. Re-runnable:
-- IF NOT EXISTS. Reversible:
--   ALTER TABLE authorized_signup_offers DROP COLUMN IF EXISTS activity_label;
ALTER TABLE "authorized_signup_offers" ADD COLUMN IF NOT EXISTS "activity_label" text;
