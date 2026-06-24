-- Enable Row-Level Security on every public table (Supabase advisor:
-- rls_disabled_in_public / sensitive_columns_exposed). The app connects as the
-- `postgres` role (BYPASSRLS), so it is unaffected; the PostgREST Data API roles
-- (anon / authenticated) get deny-by-default. Hale never uses the Data API
-- (Drizzle direct connection only) — no policies are added on purpose. Rule #1.
ALTER TABLE "actions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "agent_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "children" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "consent_records" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "conversations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "daily_digests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "families" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "family_invites" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "family_members" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "family_memory_episodes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "family_memory_facts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "family_voice_profiles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "integrations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "messages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "outbound_sends" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "routine_proposals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "village_candidates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "waitlist" ENABLE ROW LEVEL SECURITY;
