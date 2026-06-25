-- The transactional 'welcome' email stream (sent once when a family completes
-- onboarding). Additive only (rule #9): a new email_type value; existing values
-- unchanged. The welcome send is recorded in email_sends like any stream, which
-- is also how it stays idempotent (no second 'welcome' row per user).
ALTER TYPE "public"."email_type" ADD VALUE 'welcome';
