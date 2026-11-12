-- A family can hold several live signup asks for one parent, and a bare yes or no answers
-- the one Hale asked last. created_at is when the offer itself was asked; last_asked_at is
-- when Hale last sent this parent a text about the ask after that (a question back, a
-- mismatch question, a login ask, a receipt). Live asks are ordered by
-- coalesce(last_asked_at, created_at), newest first. A timestamp only: never a person,
-- a message body or a link.
-- Additive (rule #9). Nullable, no default: rows from before read as asked when created.
-- Re-runnable: IF NOT EXISTS. Reversible:
--   ALTER TABLE authorized_signup_offers DROP COLUMN IF EXISTS last_asked_at;
ALTER TABLE "authorized_signup_offers" ADD COLUMN IF NOT EXISTS "last_asked_at" timestamp with time zone;
