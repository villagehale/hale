-- Teen raw-content access grant (rule #1 named exception), additive only (rule #9).
--
-- A parent may request time-limited access to a 13+ teen's redacted content. It is
-- recorded in consent_records as a REQUEST (granted=false) with an expiry and the
-- teen is notified; the consume side (approve → granted=true, honour on read) is a
-- follow-up. Two additive changes, no destructive edits:
--   1. a new consent_type value 'teen_content_access' (existing values unchanged);
--   2. an 'expires_at' column so a grant can lapse (NULL for open-ended consents).
ALTER TYPE "public"."consent_type" ADD VALUE 'teen_content_access';--> statement-breakpoint
ALTER TABLE "consent_records" ADD COLUMN "expires_at" timestamp with time zone;
