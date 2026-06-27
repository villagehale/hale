-- Postgres-backed fixed-window rate limiting (additive only, rule #9).
-- One row per (identifier, route, window_start) holding the request count for
-- that window. identifier is a user id (authed routes) or a client IP (unauthed);
-- window_start is the floor of the current fixed window. The limiter upserts on
-- the unique index and increments count, refusing once the per-route cap is hit.
-- Serverless-safe (no extra infra). Expired windows are deleted on write, so the
-- table stays bounded without a separate cron. Carries no PII beyond the
-- identifier (rule #1).
CREATE TABLE "rate_limits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"identifier" text NOT NULL,
	"route" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "rate_limits_identifier_route_window_idx" ON "rate_limits" USING btree ("identifier","route","window_start");--> statement-breakpoint
-- Deny-by-default for the PostgREST Data API roles, same posture as 0012/0019/0020.
-- The app connects as postgres (BYPASSRLS); Hale never uses the Data API. Rule #1.
ALTER TABLE "rate_limits" ENABLE ROW LEVEL SECURITY;
