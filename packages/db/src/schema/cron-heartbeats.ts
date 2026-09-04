import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * The dead-man switch's last-ran ledger (audit P1-8). One row per cron name;
 * the shared `cronRoute` wrapper (apps/web/lib/cron/auth.ts) advances
 * `last_ran_at` when a cron handler completes, so "this cron is alive" is a
 * fact the database holds rather than an inference from logs.
 *
 * /api/health/crons compares each row's age against the cadence declared in
 * apps/web/vercel.json; the off-Vercel checker (.github/workflows/
 * cron-deadman.yml) reads that endpoint — the liveness monitor deliberately
 * does NOT share the Vercel failure domain of the crons it watches. A cron
 * the ledger has never seen is armed (inserted at now()) by the endpoint on
 * first sight: the clock starts without a false page, and a genuinely dead
 * cron trips one period later.
 */
export const cronHeartbeats = pgTable('cron_heartbeats', {
  name: text('name').primaryKey(),
  lastRanAt: timestamp('last_ran_at', { withTimezone: true }).notNull().defaultNow(),
});

export type CronHeartbeat = typeof cronHeartbeats.$inferSelect;
export type NewCronHeartbeat = typeof cronHeartbeats.$inferInsert;
