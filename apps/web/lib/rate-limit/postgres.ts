import { schema } from '@hale/db';
import { and, eq, lt, sql } from 'drizzle-orm';
import type { Database } from '@hale/db';
import type { RateLimiter, RateLimitOptions, RateLimitResult } from './limiter';

/**
 * Postgres fixed-window limiter. One UPSERT does the whole decision atomically:
 * insert the (identifier, route, window_start) row at count 1, or increment its
 * count on conflict — `RETURNING count` is the post-increment value, so the Nth
 * caller in a window reads N. Concurrent requests serialize on the unique index,
 * so the count is exact under load (no read-modify-write race). Serverless-safe:
 * no in-process state, every replica shares the same counters.
 *
 * Growth is bounded by deleting this identifier+route's expired windows on each
 * write — a cheap, indexed delete that needs no separate cron.
 */
export class PostgresRateLimiter implements RateLimiter {
  constructor(private readonly db: Database) {}

  async check(key: string, route: string, opts: RateLimitOptions): Promise<RateLimitResult> {
    const windowMs = opts.windowSec * 1000;
    const windowStart = new Date(Math.floor(Date.now() / windowMs) * windowMs);

    await this.db
      .delete(schema.rateLimits)
      .where(
        and(
          eq(schema.rateLimits.identifier, key),
          eq(schema.rateLimits.route, route),
          lt(schema.rateLimits.windowStart, windowStart),
        ),
      );

    const [row] = await this.db
      .insert(schema.rateLimits)
      .values({ identifier: key, route, windowStart, count: 1 })
      .onConflictDoUpdate({
        target: [
          schema.rateLimits.identifier,
          schema.rateLimits.route,
          schema.rateLimits.windowStart,
        ],
        set: { count: sql`${schema.rateLimits.count} + 1` },
      })
      .returning({ count: schema.rateLimits.count });

    if (!row) throw new Error('rate-limit upsert returned no row');

    const retryAfterSec = Math.ceil((windowStart.getTime() + windowMs - Date.now()) / 1000);
    return { allowed: row.count <= opts.limit, retryAfterSec };
  }
}
