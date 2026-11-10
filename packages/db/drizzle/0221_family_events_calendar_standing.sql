-- VIL-633 · where the connecting parent stands on a mirrored Google event: 'organizer' (they
-- made it), 'accepted' (they said yes to someone else's invite), 'own' (no one else is on
-- it), or 'invited' (someone else's invite, unanswered or tentative). The 1:1 calendar notice
-- speaks only of the first three. Null on every Hale-authored row and on every mirror
-- written before the column existed; the notice reads null as not known, and the next mirror
-- sweep writes it.
-- Additive (rule #9). Nullable column, no default. Re-runnable: IF NOT EXISTS. Reversible:
--   ALTER TABLE family_events DROP COLUMN IF EXISTS calendar_standing;

ALTER TABLE "family_events" ADD COLUMN IF NOT EXISTS "calendar_standing" text;
