-- The transactional 'verification' email stream (the email-confirmation link sent
-- at sign-up). Additive only (rule #9): a new email_type value; existing values
-- unchanged. The verification send is recorded in email_sends like any stream so it
-- is auditable (PIPEDA right-to-access), mirroring how 'welcome' is ledgered.
ALTER TYPE "public"."email_type" ADD VALUE 'verification';
