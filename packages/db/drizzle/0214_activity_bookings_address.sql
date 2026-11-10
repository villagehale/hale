-- The booked place's street address, as the confirmation email wrote it, so a duty-night
-- or venue text can give the place and its address. Read only from the email itself; a
-- receipt that gives none leaves it null. Add-only and nullable: every existing row and
-- every other writer leaves it null. Never copied to a log or an audit row, and it goes
-- with the family's cascade.
-- Reversible:
--   ALTER TABLE "activity_bookings" DROP COLUMN "address";
ALTER TABLE "activity_bookings" ADD COLUMN IF NOT EXISTS "address" text;
