-- VIL-474 · Keep the Linq text decorations (e.g. bold ranges) a Preview capture
-- would have sent, so a fake-family reminder proof can show which text is bold.
-- Nullable: a send without decorations stores NULL. Preview-only table.
ALTER TABLE "preview_captured_sends" ADD COLUMN IF NOT EXISTS "decorations" jsonb;
