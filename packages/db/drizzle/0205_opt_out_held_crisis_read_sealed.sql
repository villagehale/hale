-- VIL-602 · what a held text was read as when it was read as a crisis (its language, and
-- the situation and who from their closed lists), sealed in one column like other sensitive
-- content (APP_ENCRYPTION_KEY). It replaces the three plain columns of 0204, which nothing
-- writes now and which stay until a deprecation cycle drops them (rule #9). Additive,
-- nullable: a text never read as a crisis has none.
ALTER TABLE "opt_out_held_messages" ADD COLUMN IF NOT EXISTS "crisis_read_encrypted" text;
