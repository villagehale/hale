-- One live signup ask per family. A new offer closes any other pending one, and the
-- parent's next message is read against the newest ask. activity_label is the program's
-- public name as the page or the parent gave it, so the plan reader can tell a message
-- about another activity from one about this offer, and the coach can say which ask it
-- closed. Never a child, a person or a link.
-- Additive (rule #9). Nullable, no default: rows from before read as unnamed. Re-runnable:
-- IF NOT EXISTS. Reversible:
--   ALTER TABLE authorized_signup_offers DROP COLUMN IF EXISTS activity_label;
ALTER TABLE "authorized_signup_offers" ADD COLUMN IF NOT EXISTS "activity_label" text;
