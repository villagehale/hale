-- What the weekly registration re-verify sweep FOUND, as a row. Additive: one new
-- table, nothing existing is altered.
--
-- WHY A TABLE AND NOT A COLUMN ON THE CLAIM. The sweep already writes one row a week —
-- the rate_limits claim that makes the run exactly-once. It would have held a JSON
-- summary, and it is the wrong home twice over: rate_limits is a generic counter every
-- limited route in the product shares (a JSON blob for one caller makes it a grab bag),
-- and the claim is written BEFORE the work while the tally is only knowable after. Two
-- writes, two questions — "who owns this week" and "what did the run find" — so two rows.
--
-- WHY IT EXISTS AT ALL. The sweep's per-row outcomes left no trace a query could read. A
-- confirmation bumps registration_windows.verified_at; a moved date and an unreadable
-- page both deliberately write NOTHING, because an unconfirmed row must stay visibly
-- stale rather than look freshly checked. That is right for the dataset and it left the
-- founder scorecard able to count the stale rows but never to say which of the two they
-- were — "fix a seed today" and "fix the scraper" read identically.
--
-- NO family_id, NO PII. Four counts and a clock about public municipal pages, exactly
-- like the rate_limits claim beside it, so nothing here is reachable by (or in need of) a
-- right-to-erasure sweep. Rule #1.
CREATE TABLE IF NOT EXISTS "registration_verify_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	-- The Monday-aligned week swept — the same instant the rate_limits claim carries.
	"week_start" timestamp with time zone NOT NULL,
	"ran_at" timestamp with time zone DEFAULT now() NOT NULL,
	-- Windows the run attempted, bounded by its own per-run ceiling rather than by the
	-- size of the dataset.
	"checked" integer NOT NULL,
	-- Read at source and BUMPED. Deliberately no `checked = confirmed + discrepancies +
	-- unverified` constraint: a row the sweep confirmed whose verified_at write then
	-- failed is logged and skipped, so the three can legitimately fall short of checked.
	-- A constraint here would turn that logged warning into a rejected tally — losing the
	-- whole week's outcomes to make the arithmetic tidy.
	"confirmed" integer NOT NULL,
	"discrepancies" integer NOT NULL,
	"unverified" integer NOT NULL
);--> statement-breakpoint

-- One recorded run per week. The weekly claim already makes a second run impossible;
-- this is the database saying so, and it is what lets the digest read a week's outcome
-- as a single row instead of a sum it has to trust.
CREATE UNIQUE INDEX IF NOT EXISTS "registration_verify_runs_week_uniq"
	ON "registration_verify_runs" ("week_start");--> statement-breakpoint

-- Deny-by-default for the PostgREST Data API roles, same posture as every table. The
-- app connects as postgres (BYPASSRLS) and reads these server-side. Rule #1.
ALTER TABLE "registration_verify_runs" ENABLE ROW LEVEL SECURITY;
