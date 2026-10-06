import { type Database, schema } from '@hale/db';
import { and, eq, lt } from 'drizzle-orm';

/**
 * One #ops page per key per window. The spoken-line engine pages #ops whenever a line it
 * was asked for could not be written; a family whose line keeps failing would otherwise
 * page on every cron tick, and an hourly page is a page nobody reads by Tuesday.
 *
 * Same store and same shape as the provider-health incident claim: `rate_limits`, whose
 * (identifier, route, window_start) unique index makes "first writer in this window
 * wins" one atomic INSERT. Zero migration; a retention sweep on write keeps the table to
 * a handful of rows. The window is a day — a family still failing tomorrow deserves to be
 * said again.
 */

export const OPS_PAGE_CLAIM_ROUTE = 'ops:page-once';
export const OPS_PAGE_WINDOW_HOURS = 24;
const OPS_PAGE_RETENTION_DAYS = 7;

/**
 * True exactly once per key per window. When the store cannot be reached — a test's bare
 * database stand-in, or the database being what just failed — the answer is TRUE: a page
 * that goes out twice is a nuisance, a page that never goes out is the failure mode this
 * whole module exists to prevent.
 */
export async function claimOpsPage(
  database: Database,
  key: string,
  now: Date = new Date(),
): Promise<boolean> {
  if (typeof database.insert !== 'function') return true;
  const windowMs = OPS_PAGE_WINDOW_HOURS * 3_600_000;
  const windowStart = new Date(Math.floor(now.getTime() / windowMs) * windowMs);
  try {
    await database
      .delete(schema.rateLimits)
      .where(
        and(
          eq(schema.rateLimits.route, OPS_PAGE_CLAIM_ROUTE),
          lt(
            schema.rateLimits.windowStart,
            new Date(now.getTime() - OPS_PAGE_RETENTION_DAYS * 86_400_000),
          ),
        ),
      );
    const claimed = await database
      .insert(schema.rateLimits)
      .values({ identifier: key, route: OPS_PAGE_CLAIM_ROUTE, windowStart, count: 1 })
      .onConflictDoNothing({
        target: [
          schema.rateLimits.identifier,
          schema.rateLimits.route,
          schema.rateLimits.windowStart,
        ],
      })
      .returning({ id: schema.rateLimits.id });
    return claimed.length > 0;
  } catch (err) {
    console.error(
      { err: err instanceof Error ? err.name : 'unknown' },
      'ops page claim: store unavailable - paging anyway',
    );
    return true;
  }
}
