-- The question a general answer left open, on the reply that left it. Two additive
-- nullable columns (rule #9). Nothing existing changes, and nothing writes them while
-- GENERAL_ANSWER_SEARCH_ENABLED is dark.
--
-- WHY. The off-topic lane is one text in and one out. When Hale asks "which city?" the
-- parent's "Toronto" starts a new turn with no question attached, so the ask led nowhere
-- (Sloane's finding 1 on #861). The reply that left the question open now keeps it, and
-- the parent's next text is read beside it.
--
-- WHAT IS STORED, AND WHAT IS NOT (rule #1). The DE-IDENTIFIED question: the sanitize
-- stage's rewrite with the family taken out, then a deterministic scrub of phone numbers,
-- addresses and the like. And what it was missing, in a few words. Never the parent's
-- own words, which stay where they already are (the inbound row's body), and never what
-- Hale said back: `body` stays null on outbound rows as before.
--
-- WHY ON THE OUTBOUND ROW. The same reasoning as 0090 and 0103: it is a fact about the
-- REPLY. That also makes "is it still pending" a question the ledger already answers,
-- the way the readiness and check-in asks do: it stands while this row is Hale's last
-- word to that parent, and anything else Hale sends closes it. No status column, no
-- timer.
--
-- RETENTION. The 365-day message sweep clears both columns with the inbound body
-- (apps/web/lib/rights/message-retention.ts), and the family cascade removes the row.
--
-- Re-runnable: both statements are IF NOT EXISTS.
ALTER TABLE "public"."channel_messages"
  ADD COLUMN IF NOT EXISTS "pending_question" text;
--> statement-breakpoint
ALTER TABLE "public"."channel_messages"
  ADD COLUMN IF NOT EXISTS "pending_missing" text;
