import { type CityRegistrationReading, type Database, schema } from '@hale/db';
import { and, count, desc, eq, gt, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { VerifiedRegistrationReading } from '../live-reading';
import type { CityLookup } from './lookup';
import { type CityPlace, cityKey } from './place';

/**
 * VIL-684 · the per-city cache: the newest reading of a city's season wins, and every
 * reading carries the page it came from and when it is read again. A re-read that fails
 * to finish writes no reading (the lookup's `retry`), and a known date gives way to "not
 * found" only when its own page says this season is not out (sweep.ts), so a timeout, a
 * server error, a shaky read or another page's answer never turns it into "not found".
 *
 * EVERY LOOKUP MOVES THE CITY'S NEXT TURN. One that wrote no reading is still appended,
 * as a `retry` row that is never read as the reading, so the city is not due again
 * straight away: the next sweep first, then each wait twice the last, up to the
 * "not found" interval. A city whose page stays shaky can never take every lookup of
 * every run.
 */

/** How long a verified date stands before its page is read again. Cache freshness, not a
 * send rule: a city that moves a date is caught within this. */
export const REVERIFY_VERIFIED_MS = 3 * 86_400_000;
/** How long "not found" stands before the city is searched again: dates get announced. */
export const REVERIFY_NOT_FOUND_MS = 2 * 86_400_000;

/** The first wait after a lookup that wrote no reading: the next hourly sweep. */
export const RETRY_FIRST_MS = 3_600_000;

const READING_STATUSES = ['verified', 'not_found'] as const;

const dateSchema = z.object({
  kind: z.enum(['preview', 'resident_open', 'general_open', 'unclassified_open', 'member_open']),
  date: z.string(),
  time: z.string().nullable(),
  evidence: z.array(z.string()),
  yearFrom: z.literal('printed_weekday').optional(),
});

const verifiedSchema = z.object({
  sourceUrl: z.string(),
  checkedAt: z.coerce.date(),
  reader: z.enum(['ai', 'perfectmind']),
  status: z.literal('verified'),
  timeZone: z.string(),
  dates: z.array(dateSchema),
  partialDates: z.array(z.object({ kind: dateSchema.shape.kind, quote: z.string() })),
  programOnPage: z.string().optional(),
});

export type StoredCityReading =
  | {
      status: 'verified';
      municipality: string;
      sourceUrl: string;
      reading: VerifiedRegistrationReading;
      readAt: Date;
      reverifyAt: Date;
    }
  | { status: 'not_found'; reason: string | null; readAt: Date; reverifyAt: Date };

/** A stored row as the reading it is. A verified row whose reading does not parse is a
 * bug in the writer, and it throws rather than reading as "not found". */
export function storedReading(row: CityRegistrationReading): StoredCityReading {
  if (row.status === 'verified') {
    if (row.municipality === null || row.sourceUrl === null) {
      throw new Error('city registration: a verified row has no municipality or source');
    }
    return {
      status: 'verified',
      municipality: row.municipality,
      sourceUrl: row.sourceUrl,
      reading: verifiedSchema.parse(row.reading) as VerifiedRegistrationReading,
      readAt: row.readAt,
      reverifyAt: row.reverifyAt,
    };
  }
  if (row.status !== 'not_found') {
    throw new Error('city registration: a lookup that wrote no reading is not a reading');
  }
  return {
    status: 'not_found',
    reason: row.reason,
    readAt: row.readAt,
    reverifyAt: row.reverifyAt,
  };
}

export async function latestCityReading(
  database: Database,
  place: CityPlace,
  cycleLabel: string,
): Promise<StoredCityReading | null> {
  const t = schema.cityRegistrationReadings;
  const [row] = await database
    .select()
    .from(t)
    .where(
      and(
        eq(t.placeKey, cityKey(place)),
        eq(t.cycleLabel, cycleLabel),
        inArray(t.status, [...READING_STATUSES]),
      ),
    )
    .orderBy(desc(t.readAt))
    .limit(1);
  return row ? storedReading(row) : null;
}

/** When this city's season is next looked up: set by its newest lookup, whether or not
 * that lookup wrote a reading. Null when it was never looked up. */
export async function nextCityLookupAt(
  database: Database,
  place: CityPlace,
  cycleLabel: string,
): Promise<Date | null> {
  const t = schema.cityRegistrationReadings;
  const [row] = await database
    .select({ reverifyAt: t.reverifyAt })
    .from(t)
    .where(and(eq(t.placeKey, cityKey(place)), eq(t.cycleLabel, cycleLabel)))
    .orderBy(desc(t.readAt))
    .limit(1);
  return row?.reverifyAt ?? null;
}

/** Append a lookup that wrote no reading. It waits twice as long as the one before it
 * since the last reading, from the next sweep up to the "not found" interval. */
export async function recordUnfinishedLookup(
  database: Database,
  place: CityPlace,
  cycleLabel: string,
  reason: string,
  now: Date,
): Promise<void> {
  const t = schema.cityRegistrationReadings;
  const key = cityKey(place);
  const reading = await latestCityReading(database, place, cycleLabel);
  const [{ unfinished } = { unfinished: 0 }] = await database
    .select({ unfinished: count() })
    .from(t)
    .where(
      and(
        eq(t.placeKey, key),
        eq(t.cycleLabel, cycleLabel),
        eq(t.status, 'retry'),
        ...(reading === null ? [] : [gt(t.readAt, reading.readAt)]),
      ),
    );
  const wait = Math.min(RETRY_FIRST_MS * 2 ** unfinished, REVERIFY_NOT_FOUND_MS);
  await database.insert(t).values({
    placeKey: key,
    city: place.city,
    provinceOrState: place.provinceOrState,
    country: place.country,
    district: place.district,
    cycleLabel,
    status: 'retry',
    reason,
    municipality: null,
    sourceUrl: null,
    reading: null,
    readAt: now,
    reverifyAt: new Date(now.getTime() + wait),
  });
}

/** Append one lookup's reading. A `retry` is not a reading (recordUnfinishedLookup). */
export async function recordCityReading(
  database: Database,
  place: CityPlace,
  cycleLabel: string,
  lookup: Exclude<CityLookup, { status: 'retry' }>,
  now: Date,
): Promise<void> {
  const base = {
    placeKey: cityKey(place),
    city: place.city,
    provinceOrState: place.provinceOrState,
    country: place.country,
    district: place.district,
    cycleLabel,
    readAt: now,
  };
  if (lookup.status === 'verified') {
    await database.insert(schema.cityRegistrationReadings).values({
      ...base,
      status: 'verified',
      reason: null,
      municipality: lookup.municipality,
      sourceUrl: lookup.sourceUrl,
      reading: JSON.parse(JSON.stringify(lookup.reading)) as Record<string, unknown>,
      reverifyAt: new Date(now.getTime() + REVERIFY_VERIFIED_MS),
    });
    return;
  }
  await database.insert(schema.cityRegistrationReadings).values({
    ...base,
    status: 'not_found',
    reason: lookup.reason,
    municipality: lookup.municipality,
    sourceUrl: null,
    reading: null,
    reverifyAt: new Date(now.getTime() + REVERIFY_NOT_FOUND_MS),
  });
}
