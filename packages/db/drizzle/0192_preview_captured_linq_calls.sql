-- VIL-466 groups · Partner calls a Preview capture run made to a fake group chat
-- instead of reaching Linq (messages, tapbacks, polls, typing, chat create/update)
-- plus the fake roster the Preview group door seeded. Written only on a Vercel
-- Preview deploy with PREVIEW_CAPTURE_TRANSPORT=on, PREVIEW_CAPTURE_GROUPS=on and
-- no Linq key or line (apps/web/lib/channel/preview-linq-capture.ts). Production
-- never writes here. Handles are the fictional +1 437-555 probe range only.
-- Reversible:
--   DROP TABLE "preview_captured_linq_calls";
CREATE TABLE IF NOT EXISTS "preview_captured_linq_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chat_id" text NOT NULL,
	"kind" text NOT NULL,
	"method" text NOT NULL,
	"path" text NOT NULL,
	"body" jsonb,
	"handles" jsonb,
	"provider_message_id" text,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "preview_captured_linq_calls_chat_idx" ON "preview_captured_linq_calls" USING btree ("chat_id","captured_at");
