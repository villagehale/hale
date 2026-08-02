import { type Database, schema } from '@hale/db';
import type { CivicSystem } from '@hale/db';
import { and, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { CivicAdapter, CivicHarvest, FetchJson } from './types';

/**
 * VIL-252 · M16 — the weekly refresh, and the discipline it inherits from M1.
 *
 * NEVER SILENTLY CHANGE. A schedule that has stopped being published is not a
 * schedule that is still true. So a session the sweep no longer sees upstream is
 * SUPERSEDED rather than left in place, a past one-off expires by its own end
 * time, and an audience vocabulary this code does not recognise is reported as a
 * coverage gap instead of being quietly reinterpreted. Every outcome is a count in
 * the returned summary, so "we surfaced less this week" is visible rather than
 * inferred.
 *
 * WHAT IS NOT DONE HERE, DELIBERATELY: nothing is deleted, and nothing already
 * shown to a family is edited in place. Rows are soft-retired (superseded_at), so
 * a disappearance stays auditable — the same reason village discovery soft-stamps
 * rather than deleting.
 */

export interface CivicSystemSummary {
  system: CivicSystem;
  venues: number;
  sessions: number;
  /** Rows retired this run because upstream stopped listing them. */
  superseded: number;
  /** Past one-off events retired by their own end time. */
  expired: number;
  /** Audience labels the registry has no age mapping for. A non-empty list means
   * that system's coverage is INCOMPLETE this week — events under those labels
   * were skipped, not guessed at. */
  unknownAudienceIds: string[];
  /** Set when this system failed; the other systems still ran. */
  error?: string;
}

/** A failure in one system must not cost the others their refresh — the same
 * per-family isolation the discovery cron uses. */
export async function runCivicSweep(
  database: Database,
  adapters: readonly CivicAdapter[],
  fetchJson: FetchJson,
  now: Date = new Date(),
): Promise<CivicSystemSummary[]> {
  const summaries: CivicSystemSummary[] = [];
  for (const adapter of adapters) {
    try {
      summaries.push(await sweepSystem(database, adapter, fetchJson, now));
    } catch (err) {
      console.error({ err, system: adapter.system }, 'civic sweep: system failed');
      summaries.push({
        system: adapter.system,
        venues: 0,
        sessions: 0,
        superseded: 0,
        expired: 0,
        unknownAudienceIds: [],
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return summaries;
}

async function sweepSystem(
  database: Database,
  adapter: CivicAdapter,
  fetchJson: FetchJson,
  now: Date,
): Promise<CivicSystemSummary> {
  const harvest = await adapter.harvest(fetchJson);
  const venueIds = await upsertVenues(database, harvest, now);
  const seen = await upsertSessions(database, harvest, venueIds, now);

  const allVenueIds = [...venueIds.values()];
  let superseded = 0;
  let expired = 0;

  if (allVenueIds.length > 0) {
    // Anything at this system's venues that this run did NOT touch is no longer
    // published. `last_seen_at < now` is the marker because every row the harvest
    // contained was just stamped with `now`.
    const gone = await database
      .update(schema.civicSessions)
      .set({ supersededAt: now, updatedAt: now })
      .where(
        and(
          inArray(schema.civicSessions.venueId, allVenueIds),
          isNull(schema.civicSessions.supersededAt),
          lt(schema.civicSessions.lastSeenAt, now),
        ),
      )
      .returning({ id: schema.civicSessions.id });
    superseded = gone.length;

    const past = await database
      .update(schema.civicSessions)
      .set({ supersededAt: now, updatedAt: now })
      .where(
        and(
          inArray(schema.civicSessions.venueId, allVenueIds),
          isNull(schema.civicSessions.supersededAt),
          eq(schema.civicSessions.recurrence, 'occurrence'),
          lt(schema.civicSessions.endsAt, now),
        ),
      )
      .returning({ id: schema.civicSessions.id });
    expired = past.length;
  }

  if (harvest.unknownAudienceIds.length > 0) {
    console.error(
      { system: adapter.system, unknown: harvest.unknownAudienceIds },
      'civic sweep: unmapped audience labels — those events were SKIPPED, extend library-systems.ts',
    );
  }

  return {
    system: adapter.system,
    venues: venueIds.size,
    sessions: seen,
    superseded,
    expired,
    unknownAudienceIds: harvest.unknownAudienceIds,
  };
}

/** Upsert on the natural key (system, external_id); returns external id → row id. */
async function upsertVenues(
  database: Database,
  harvest: CivicHarvest,
  now: Date,
): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  if (harvest.venues.length === 0) return ids;

  const rows = await database
    .insert(schema.civicVenues)
    .values(
      harvest.venues.map((venue) => ({
        system: venue.system,
        externalId: venue.externalId,
        kind: venue.kind,
        name: venue.name,
        address: venue.address,
        city: venue.city,
        postalCode: venue.postalCode,
        lat: venue.lat,
        lng: venue.lng,
        url: venue.url,
        sourceUrl: venue.sourceUrl,
        lastSeenAt: now,
        updatedAt: now,
      })),
    )
    .onConflictDoUpdate({
      target: [schema.civicVenues.system, schema.civicVenues.externalId],
      set: {
        name: sql`excluded.name`,
        address: sql`excluded.address`,
        city: sql`excluded.city`,
        postalCode: sql`excluded.postal_code`,
        lat: sql`excluded.lat`,
        lng: sql`excluded.lng`,
        url: sql`excluded.url`,
        sourceUrl: sql`excluded.source_url`,
        lastSeenAt: now,
        updatedAt: now,
      },
    })
    .returning({ id: schema.civicVenues.id, externalId: schema.civicVenues.externalId });

  for (const row of rows) ids.set(row.externalId, row.id);
  return ids;
}

/**
 * Upsert on (venue_id, external_id). A session whose times CHANGED upstream is
 * updated and re-stamped — that is the honest read of "the library moved
 * storytime". What is never done is inventing a row for a venue the harvest did
 * not include.
 */
async function upsertSessions(
  database: Database,
  harvest: CivicHarvest,
  venueIds: ReadonlyMap<string, string>,
  now: Date,
): Promise<number> {
  const values = harvest.sessions
    .map((session) => {
      const venueId = venueIds.get(session.venueExternalId);
      if (venueId === undefined) return null;
      return {
        venueId,
        externalId: session.externalId,
        title: session.title,
        summary: session.summary,
        recurrence: session.recurrence,
        startsAt: session.startsAt,
        endsAt: session.endsAt,
        dayOfWeek: session.dayOfWeek,
        startMinute: session.startMinute,
        endMinute: session.endMinute,
        ageMinMonths: session.ageMinMonths,
        ageMaxMonths: session.ageMaxMonths,
        isFree: session.isFree,
        registrationRequired: session.registrationRequired,
        isCancelled: session.isCancelled,
        extraction: session.extraction,
        confidence: session.confidence,
        sourceUrl: session.sourceUrl,
        parsedAt: now,
        lastSeenAt: now,
        // A row that had been retired and is published again comes back.
        supersededAt: null,
        updatedAt: now,
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);

  if (values.length === 0) return 0;

  // Chunked so a system with thousands of forward events (Toronto runs ~6,000)
  // cannot blow the parameter limit on a single statement.
  const CHUNK = 500;
  let written = 0;
  for (let i = 0; i < values.length; i += CHUNK) {
    const rows = await database
      .insert(schema.civicSessions)
      .values(values.slice(i, i + CHUNK))
      .onConflictDoUpdate({
        target: [schema.civicSessions.venueId, schema.civicSessions.externalId],
        set: {
          title: sql`excluded.title`,
          summary: sql`excluded.summary`,
          recurrence: sql`excluded.recurrence`,
          startsAt: sql`excluded.starts_at`,
          endsAt: sql`excluded.ends_at`,
          dayOfWeek: sql`excluded.day_of_week`,
          startMinute: sql`excluded.start_minute`,
          endMinute: sql`excluded.end_minute`,
          ageMinMonths: sql`excluded.age_min_months`,
          ageMaxMonths: sql`excluded.age_max_months`,
          isFree: sql`excluded.is_free`,
          registrationRequired: sql`excluded.registration_required`,
          isCancelled: sql`excluded.is_cancelled`,
          extraction: sql`excluded.extraction`,
          confidence: sql`excluded.confidence`,
          sourceUrl: sql`excluded.source_url`,
          parsedAt: now,
          lastSeenAt: now,
          supersededAt: null,
          updatedAt: now,
        },
      })
      .returning({ id: schema.civicSessions.id });
    written += rows.length;
  }
  return written;
}
