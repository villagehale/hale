import { type CityRegistrationReading, type Database, schema } from '@hale/db';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { VerifiedRegistrationReading } from '../live-reading';
import type { CityLookup } from './lookup';
import { type OwnCity, cityKey } from './place';

/**
 * VIL-684 · the per-city cache: the newest reading of a city's season wins, and every
 * reading carries the page it came from and when it is read again. A re-read that fails
 * to finish writes nothing (the lookup's `retry`), so a busy hour never turns a known
 * date into "not found".
 */

/** How long a verified date stands before its page is read again. Cache freshness, not a
 * send rule: a city that moves a date is caught within this. */
export const REVERIFY_VERIFIED_MS = 3 * 86_400_000;
/** How long "not found" stands before the city is searched again: dates get announced. */
export const REVERIFY_NOT_FOUND_MS = 2 * 86_400_000;

const dateSchema = z.object({
  kind: z.enum(['preview', 'resident_open', 'general_open', 'unclassified_open', 'member_open']),
  date: z.string(),
  time: z.string().nullable(),
  evidence: z.array(z.string()),
});

const verifiedSchema = z.object({
  sourceUrl: z.string(),
  checkedAt: z.coerce.date(),
  reader: z.enum(['ai', 'perfectmind']),
  status: z.literal('verified'),
  timeZone: z.string(),
  dates: z.array(dateSchema),
  partialDates: z.array(z.object({ kind: dateSchema.shape.kind, quote: z.string() })),
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
  return {
    status: 'not_found',
    reason: row.reason,
    readAt: row.readAt,
    reverifyAt: row.reverifyAt,
  };
}

export async function latestCityReading(
  database: Database,
  place: OwnCity,
  cycleLabel: string,
): Promise<StoredCityReading | null> {
  const t = schema.cityRegistrationReadings;
  const [row] = await database
    .select()
    .from(t)
    .where(and(eq(t.placeKey, cityKey(place)), eq(t.cycleLabel, cycleLabel)))
    .orderBy(desc(t.readAt))
    .limit(1);
  return row ? storedReading(row) : null;
}

/** Append one lookup's outcome. A `retry` is not a reading and is never stored. */
export async function recordCityReading(
  database: Database,
  place: OwnCity,
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
