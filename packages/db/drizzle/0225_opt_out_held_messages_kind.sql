-- VIL-553 · what a hold row holds. 'message' is a text whose opt-out read failed, released
-- when that text is read. 'id_collision' is a number whose text shares its provider id with
-- another number's hold, so no store can place it: only an operator clears it. Code treats
-- any other value as a collision and keeps it. Additive; every standing row is a message hold.
ALTER TABLE "opt_out_held_messages" ADD COLUMN IF NOT EXISTS "kind" text NOT NULL DEFAULT 'message';
