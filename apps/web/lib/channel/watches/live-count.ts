import { type Database, schema } from '@hale/db';
import { and, eq, isNull, sql } from 'drizzle-orm';

/**
 * Live watches for one family: unreleased `watched_spots` plus unremoved
 * `family_watch_subscriptions`. The two tables are the two ways a parent asks
 * Hale to keep looking, and the entitlement cap counts them together.
 */
export async function countFamilyLiveWatches(
  database: Database,
  familyId: string,
): Promise<number> {
  const [spots] = await database
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.watchedSpots)
    .where(and(eq(schema.watchedSpots.familyId, familyId), isNull(schema.watchedSpots.releasedAt)));
  const [subs] = await database
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.familyWatchSubscriptions)
    .where(
      and(
        eq(schema.familyWatchSubscriptions.familyId, familyId),
        isNull(schema.familyWatchSubscriptions.removedAt),
      ),
    );
  return (spots?.n ?? 0) + (subs?.n ?? 0);
}
