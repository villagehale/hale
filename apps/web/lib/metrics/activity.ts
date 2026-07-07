import { type Database, schema } from '@hale/db';
import { sql } from 'drizzle-orm';

/**
 * Records that a family opened the app today (Toronto-local day, matching the
 * product's Canada-first audience). Day-grain upsert — at most one row per
 * family per day, no content, no user identity (rule #1). Called fire-and-
 * forget from the authed layout via after(), so it never blocks a paint.
 */
export async function markFamilyActiveToday(database: Database, familyId: string): Promise<void> {
  await database
    .insert(schema.familyActiveDays)
    .values({ familyId, day: sql`(now() at time zone 'America/Toronto')::date` })
    .onConflictDoNothing();
}
