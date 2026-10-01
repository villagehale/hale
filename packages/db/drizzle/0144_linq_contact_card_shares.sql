-- One row per Linq chat that has already received Hale's Name and Photo card.
--
-- Additive (rule #9). Reversible:
--   DROP TABLE IF EXISTS linq_contact_card_shares;
-- Nothing existing is altered. Re-runnable: IF NOT EXISTS throughout.
--
-- A row is inserted only after Linq accepts the share. Absence means a later
-- send may try again (including after error 2012). chat_id is Linq's chat id,
-- already stored elsewhere as provider_chat_id. No phone number, no body.
CREATE TABLE IF NOT EXISTS "linq_contact_card_shares" (
	"chat_id" text PRIMARY KEY NOT NULL,
	"shared_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "linq_contact_card_shares" ENABLE ROW LEVEL SECURITY;
