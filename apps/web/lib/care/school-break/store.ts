import { type Database, type SchoolBreakReading, schema } from '@hale/db';
import { and, count, desc, eq, gt, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { BoardLookup } from './lookup';
import type { VerifiedBreakReading } from './read';

/**
 * VIL-685 · the per-host cache: the newest reading of a school's year wins, and every
 * reading carries the page it came from and when it is read again. A lookup that did not
 * finish is logged as a `retry` row and is not a reading, so a busy hour never turns a
 * known break into "not found". Retries are bounded: after {@link MAX_LOOKUP_TRIES}
 * unfinished lookups in a row the host is `not_found` (`lookup_unfinished`) and its
 * families are asked, rather than waiting forever on a search that never answers.
 */

/** How long a verified break stands before its page is read again. Cache freshness, not
 * a send rule: a board that moves its break is caught within this. */
export const REVERIFY_VERIFIED_MS = 7 * 86_400_000;
/** How long "not found" stands before the board is searched again: calendars get posted. */
export const REVERIFY_NOT_FOUND_MS = 3 * 86_400_000;
/** Lookups of one host that may end unfinished in a row before its families are asked. */
export const MAX_LOOKUP_TRIES = 3;

const READING_STATUSES = ['verified', 'not_found'] as const;

const daySchema = z.object({ date: z.string(), quote: z.string() });
const readingSchema = z.object({ name: z.string(), firstDay: daySchema, lastDay: daySchema });

export type StoredBoardReading =
  | ({
      status: 'verified';
      boardName: string;
      sourceUrl: string;
      readAt: Date;
      reverifyAt: Date;
    } & VerifiedBreakReading)
  | { status: 'not_found'; reason: string | null; readAt: Date; reverifyAt: Date };

/** A stored row as the reading it is. A verified row that does not parse is a writer
 * bug, and it throws rather than reading as "not found". */
export function storedBoardReading(row: SchoolBreakReading): StoredBoardReading {
  if (row.status === 'retry')
    throw new Error('school break: an unfinished lookup is not a reading');
  if (row.status === 'verified') {
    if (row.boardName === null || row.sourceUrl === null) {
      throw new Error('school break: a verified row has no board or source');
    }
    return {
      status: 'verified',
      boardName: row.boardName,
      sourceUrl: row.sourceUrl,
      readAt: row.readAt,
      reverifyAt: row.reverifyAt,
      ...readingSchema.parse(row.reading),
    };
  }
  return {
    status: 'not_found',
    reason: row.reason,
    readAt: row.readAt,
    reverifyAt: row.reverifyAt,
  };
}

export async function latestBoardReading(
  database: Database,
  boardHost: string,
  schoolYear: string,
): Promise<StoredBoardReading | null> {
  const t = schema.schoolBreakReadings;
  const [row] = await database
    .select()
    .from(t)
    .where(
      and(
        eq(t.boardHost, boardHost),
        eq(t.schoolYear, schoolYear),
        inArray(t.status, [...READING_STATUSES]),
      ),
    )
    .orderBy(desc(t.readAt))
    .limit(1);
  return row ? storedBoardReading(row) : null;
}

/** Unfinished lookups of this host since its newest reading (all of them, with none). */
export async function unfinishedLookups(
  database: Database,
  boardHost: string,
  schoolYear: string,
  since: Date | null,
): Promise<number> {
  const t = schema.schoolBreakReadings;
  const [row] = await database
    .select({ n: count() })
    .from(t)
    .where(
      and(
        eq(t.boardHost, boardHost),
        eq(t.schoolYear, schoolYear),
        eq(t.status, 'retry'),
        since === null ? undefined : gt(t.readAt, since),
      ),
    );
  return row?.n ?? 0;
}

/** Log one unfinished lookup. Not a reading: {@link latestBoardReading} never returns it. */
export async function recordUnfinishedLookup(
  database: Database,
  boardHost: string,
  schoolYear: string,
  reason: string,
  now: Date,
): Promise<void> {
  await database.insert(schema.schoolBreakReadings).values({
    boardHost,
    schoolYear,
    status: 'retry',
    reason,
    boardName: null,
    sourceUrl: null,
    reading: null,
    readAt: now,
    reverifyAt: now,
  });
}

/** Append one finished lookup's outcome. */
export async function recordBoardReading(
  database: Database,
  boardHost: string,
  schoolYear: string,
  lookup:
    | Exclude<BoardLookup, { status: 'retry' }>
    | { status: 'not_found'; reason: 'lookup_unfinished'; boardName: null },
  now: Date,
): Promise<void> {
  const base = { boardHost, schoolYear, readAt: now };
  if (lookup.status === 'verified') {
    const { name, firstDay, lastDay } = lookup;
    await database.insert(schema.schoolBreakReadings).values({
      ...base,
      status: 'verified',
      reason: null,
      boardName: lookup.boardName,
      sourceUrl: lookup.sourceUrl,
      reading: { name, firstDay, lastDay },
      reverifyAt: new Date(now.getTime() + REVERIFY_VERIFIED_MS),
    });
    return;
  }
  await database.insert(schema.schoolBreakReadings).values({
    ...base,
    status: 'not_found',
    reason: lookup.reason,
    boardName: lookup.boardName,
    sourceUrl: null,
    reading: null,
    reverifyAt: new Date(now.getTime() + REVERIFY_NOT_FOUND_MS),
  });
}
