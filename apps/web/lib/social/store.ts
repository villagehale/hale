import type { Database } from '@hale/db';
import { schema } from '@hale/db';
import { and, asc, eq, isNull, or, sql } from 'drizzle-orm';
import type { SocialWatchPorts, SpotInsert } from './poll';
import type { SignupWatchRow, SignupWatchStore } from './signup-watch';

/**
 * VIL-378 — Postgres adapters. The poll logic stays on ports so tests do not
 * need a database. Facebook pages are selected out: Page Public Content Access
 * is a later review, and this poll is Business Discovery only.
 */

export function drizzleSignupStore(database: Database): SignupWatchStore {
  return {
    async due(now) {
      const rows = await database
        .select({
          id: schema.socialSpots.id,
          registrationOpensAt: schema.socialSpots.registrationOpensAt,
          registrationUrl: schema.socialSpots.registrationUrl,
          watchStatus: schema.socialSpots.watchStatus,
        })
        .from(schema.socialSpots)
        .where(
          and(
            sql`${schema.socialSpots.nextWakeAt} <= ${now}`,
            sql`${schema.socialSpots.watchStatus} IN ('scheduled', 'armed')`,
          ),
        );
      const due: SignupWatchRow[] = [];
      for (const row of rows) {
        if (!row.registrationOpensAt || !row.registrationUrl) continue;
        if (row.watchStatus !== 'scheduled' && row.watchStatus !== 'armed') continue;
        due.push({
          id: row.id,
          registrationOpensAt: row.registrationOpensAt,
          registrationUrl: row.registrationUrl,
          watchStatus: row.watchStatus,
        });
      }
      return due;
    },
    async save(id, patch) {
      await database
        .update(schema.socialSpots)
        .set({ watchStatus: patch.watchStatus, nextWakeAt: patch.nextWakeAt })
        .where(eq(schema.socialSpots.id, id));
    },
  };
}

export function drizzleSocialPorts(
  database: Database,
  now: Date,
  hooks: Pick<SocialWatchPorts, 'poll' | 'extract' | 'fetchPage' | 'llm'>,
): SocialWatchPorts {
  return {
    now,
    ...hooks,
    signupStore: drizzleSignupStore(database),
    async listDue(limit) {
      const rows = await database
        .select({
          id: schema.watchedSources.id,
          handle: schema.watchedSources.handle,
          displayName: schema.watchedSources.displayName,
          category: schema.watchedSources.category,
          region: schema.watchedSources.region,
          geoFsa: schema.watchedSources.geoFsa,
          lastMediaId: schema.watchedSources.lastMediaId,
        })
        .from(schema.watchedSources)
        .where(
          and(
            eq(schema.watchedSources.active, true),
            eq(schema.watchedSources.platform, 'instagram'),
            eq(schema.watchedSources.ingestMethod, 'graph_business_discovery'),
            or(
              isNull(schema.watchedSources.lastPolledAt),
              sql`${schema.watchedSources.lastPolledAt} <= now() - (${schema.watchedSources.pollCadenceMinutes} * interval '1 minute')`,
            ),
          ),
        )
        .orderBy(asc(schema.watchedSources.priority), asc(schema.watchedSources.lastPolledAt))
        .limit(limit);
      return rows;
    },
    async markPolled(id, lastMediaId, polledAt) {
      await database
        .update(schema.watchedSources)
        .set({ lastMediaId, lastPolledAt: polledAt, updatedAt: polledAt })
        .where(eq(schema.watchedSources.id, id));
    },
    async insertSpot(spot: SpotInsert) {
      const inserted = await database
        .insert(schema.socialSpots)
        .values({
          sourceId: spot.sourceId,
          platformMediaId: spot.platformMediaId,
          permalink: spot.permalink,
          rawCaption: spot.rawCaption,
          mediaKind: spot.mediaKind,
          title: spot.title,
          description: spot.description,
          startsAt: spot.startsAt,
          endsAt: spot.endsAt,
          ageMin: spot.ageMin,
          ageMax: spot.ageMax,
          priceCents: spot.priceCents,
          capacity: spot.capacity,
          registrationOpensAt: spot.registrationOpensAt,
          registrationUrl: spot.registrationUrl,
          venueName: spot.venueName,
          category: spot.category,
          region: spot.region,
          geoFsa: spot.geoFsa,
          extractionConfidence: spot.extractionConfidence,
          extractionMethod: spot.extractionMethod,
          reviewStatus: spot.reviewStatus,
          watchStatus: spot.watchStatus,
          nextWakeAt: spot.nextWakeAt,
        })
        .onConflictDoNothing({
          target: [schema.socialSpots.sourceId, schema.socialSpots.platformMediaId],
        })
        .returning({ id: schema.socialSpots.id });
      const created = inserted[0];
      if (!created) return { skipped: 'duplicate' };
      return created;
    },
  };
}
