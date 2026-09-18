-- A connector sync that stops must say WHY (rule #11). markConnectionError set status
-- and updated_at and nothing else, so 'error' was a dead end: Settings said "Sync
-- failing", the logs said nothing, and a gcal connection sat broken for fifteen days
-- with the reason recorded nowhere. last_error_code carries a short, PII-free class --
-- the HTTP status Google answered with ('google_400') or the step that failed
-- ('no_refresh_token') -- and NEVER a line of the response body, which can hold an
-- access token, a calendar title, or a parent's address (rule #1). The next successful
-- sync clears it. Additive, nullable, no default: an untouched row reads "errored
-- before we recorded reasons", which is the truth. (rule #9)
ALTER TABLE "public"."integrations"
  ADD COLUMN IF NOT EXISTS "last_error_code" text;
