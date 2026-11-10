-- VIL-466 · Sends the Preview capture transport recorded instead of sending.
-- Written only on a Vercel Preview deploy with PREVIEW_CAPTURE_TRANSPORT=on and
-- no Linq key or line (apps/web/lib/channel/preview-capture-transport.ts), so a
-- fake-family proof run can be read back word for word. Production never writes
-- here: the capture transport refuses outside Preview. Recipients are the
-- fictional +1 437-555 probe range only.
-- Reversible:
--   DROP TABLE "preview_captured_sends";
CREATE TABLE IF NOT EXISTS "preview_captured_sends" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"to_e164" text NOT NULL,
	"body" text NOT NULL,
	"media_urls" jsonb,
	"provider_message_id" text NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "preview_captured_sends_to_idx" ON "preview_captured_sends" USING btree ("to_e164","captured_at");
