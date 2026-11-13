import { type Database, type SchoolBreakReading, schema } from '@hale/db';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { BoardLookup } from './lookup';
import type { VerifiedBreakReading } from './read';

/**
 * VIL-685 · the per-board cache: the newest reading of a board's school year wins, and
 * every reading carries the page it came from and when it is read again. A lookup that
 * did not finish writes nothing (`retry`), so a busy hour never turns a known break into
 * "not found".
 */

/** How long a verified break stands before its page is read again. Cache freshness, not
 * a send rule: a board that moves its break is caught within this. */
export const REVERIFY_VERIFIED_MS = 7 * 86_400_000;
/** How long "not found" stands before the board is searched again: calendars get posted. */
export const REVERIFY_NOT_FOUND_MS = 3 * 86_400_000;

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
    .where(and(eq(t.boardHost, boardHost), eq(t.schoolYear, schoolYear)))
    .orderBy(desc(t.readAt))
    .limit(1);
  return row ? storedBoardReading(row) : null;
}

/** Append one lookup's outcome. A `retry` is not a reading and is never stored. */
export async function recordBoardReading(
  database: Database,
  boardHost: string,
  schoolYear: string,
  lookup: Exclude<BoardLookup, { status: 'retry' }>,
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
