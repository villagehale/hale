-- DESTRUCTIVE by explicit founder approval (per Barton's retire-auth decision
-- 2026-10-09, relayed by Sloane): drop the retired email/password and magic-link
-- sign-in tables. All three hold 0 rows in prod (read-only pre-check). The only
-- foreign key in or out is password_reset_tokens.credential_id -> credentials,
-- which links two tables both being dropped. No views, functions or policies
-- depend on them. RLS is enabled with 0 policies. DROP removes each table's
-- indexes. Re-runnable.
DROP TABLE IF EXISTS "password_reset_tokens", "magic_link_tokens", "credentials";
