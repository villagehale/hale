-- DESTRUCTIVE by explicit founder approval 2026-08-28 (VIL-331-adjacent cleanup;
-- the rule #9 gate is satisfied by that approval). All eight tables are 0 rows at
-- drop time; every code path that read or wrote them was deleted earlier on this
-- branch. None has an inbound FK from any surviving table, so order is
-- unconstrained; each DROP removes its own outbound FKs, indexes and policies.
DROP TABLE IF EXISTS "child_documents";
DROP TABLE IF EXISTS "daily_digests";
DROP TABLE IF EXISTS "family_voice_profiles";
DROP TABLE IF EXISTS "connector_connect_nonces";
DROP TABLE IF EXISTS "waitlist";
DROP TABLE IF EXISTS "push_tokens";
DROP TABLE IF EXISTS "push_sends";
DROP TABLE IF EXISTS "routine_proposals";
