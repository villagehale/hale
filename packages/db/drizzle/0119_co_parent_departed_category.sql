-- VIL-355 follow-up · the one text the parent who STAYS gets when their co-parent
-- leaves. Additive (rule #9), and its own category rather than 'co_parent_invite':
-- that lane is the invite exchange the parent started, while this is Hale making
-- contact first about a seat that ended, and a PIPEDA right-to-access read has to be
-- able to tell those two apart.
ALTER TYPE "public"."channel_message_category" ADD VALUE IF NOT EXISTS 'co_parent_departed';
