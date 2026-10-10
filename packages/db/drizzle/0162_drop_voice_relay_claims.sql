-- DESTRUCTIVE by explicit founder approval (Barton, 2026-10-10 delete-only cleanup,
-- relayed by Sloane): drop the retired Twilio ConversationRelay claim table.
-- Nothing has written it since the voice relay was retired; the only row is one
-- CallSid from 2026-08-26 with no number, name or family on it. No code reads or
-- writes it, no foreign key points at it, and no view depends on it (prod-checked
-- 2026-10-10). DROP removes its own index and RLS policies. Re-runnable.
DROP TABLE IF EXISTS "voice_relay_claims";
