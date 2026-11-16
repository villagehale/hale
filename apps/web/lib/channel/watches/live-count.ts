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

/** True when this family already has a live watched-spot row for this page. */
export async function familyHasLiveSpotWatch(
  database: Database,
  familyId: string,
  sourceUrl: string,
): Promise<boolean> {
  const [row] = await database
    .select({ id: schema.watchedSpots.id })
    .from(schema.watchedSpots)
    .where(
      and(
        eq(schema.watchedSpots.familyId, familyId),
        eq(schema.watchedSpots.sourceUrl, sourceUrl),
        isNull(schema.watchedSpots.releasedAt),
      ),
    )
    .limit(1);
  return row !== undefined;
}
