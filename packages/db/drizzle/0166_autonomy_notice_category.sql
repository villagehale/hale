-- VIL-131 · the text a parent gets when a kind turns on, and the text when Hale
-- then does that kind without asking. Additive (rule #9).
-- Their own categories rather than 'nudge': the outbound gate counts a category,
-- and telling a parent a kind turned on must not spend the weekly nudge budget.
-- Neither value is used in this transaction, so ADD VALUE is safe here.
ALTER TYPE "public"."channel_message_category" ADD VALUE IF NOT EXISTS 'autonomy_armed';--> statement-breakpoint
ALTER TYPE "public"."channel_message_category" ADD VALUE IF NOT EXISTS 'autonomy_acted';
