-- DESTRUCTIVE by explicit founder approval, 2026-08-28/29 operator session:
-- the 5-table drop list was approved verbatim ("approved"), and push_tokens,
-- push_sends, routine_proposals were each approved through an interactive
-- decision ("Drop it all" / "Drop the leg the recommended way"). All eight
-- tables held 0 rows at drop time; every code path that read or wrote them is
-- deleted on this branch. No inbound FKs from surviving tables; order is
-- unconstrained; each DROP removes its own outbound FKs, indexes and policies.
DROP TABLE IF EXISTS "child_documents";--> statement-breakpoint
DROP TABLE IF EXISTS "daily_digests";--> statement-breakpoint
DROP TABLE IF EXISTS "family_voice_profiles";--> statement-breakpoint
DROP TABLE IF EXISTS "connector_connect_nonces";--> statement-breakpoint
DROP TABLE IF EXISTS "waitlist";--> statement-breakpoint
DROP TABLE IF EXISTS "push_tokens";--> statement-breakpoint
DROP TABLE IF EXISTS "push_sends";--> statement-breakpoint
DROP TABLE IF EXISTS "routine_proposals";
