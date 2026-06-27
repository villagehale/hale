import { pgTable, uuid, text, timestamp, integer, uniqueIndex } from 'drizzle-orm/pg-core';

/**
 * Fixed-window rate-limit counters. One row per (identifier, route, window_start):
 * `identifier` is the caller (a user id for an authed route, a client IP for an
 * unauthed one), `route` is the limited endpoint, `window_start` is the floor of
 * the current window. The limiter upserts and increments `count`; over the cap it
 * refuses. The unique index makes the upsert atomic and keeps the lookup a single
 * indexed point read. Postgres-backed so it works on serverless (Vercel) with no
 * extra infra. Carries no PII beyond the identifier itself (rule #1); expired
 * windows are deleted on write so the table stays bounded.
 */
export const rateLimits = pgTable(
  'rate_limits',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    identifier: text('identifier').notNull(),
    route: text('route').notNull(),
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    count: integer('count').notNull().default(0),
  },
  (table) => ({
    windowIdx: uniqueIndex('rate_limits_identifier_route_window_idx').on(
      table.identifier,
      table.route,
      table.windowStart,
    ),
  }),
);

export type RateLimit = typeof rateLimits.$inferSelect;
export type NewRateLimit = typeof rateLimits.$inferInsert;
