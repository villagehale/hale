import { and, desc, eq, gte } from 'drizzle-orm';
import { type Database, schema } from '@haru/db';
import { db as defaultDb } from '~/lib/db';
import { currentFamilyId } from '~/lib/family';
import {
  type DigestEntryView,
  type DigestTally,
  type DraftView,
  type TrailView,
  toDigestEntry,
  toDigestTally,
  toDraftView,
  toTrailView,
} from './mappers';

/**
 * The dashboard pages run in a credential-less preview (no DATABASE_URL, no
 * Clerk) for screenshots, AND in a real authed session. `readForFamily` lands
 * both worlds on the same calm empty state — but only for the two EXPECTED
 * boundaries: no DATABASE_URL (preview), or no resolved family (unauthed /
 * onboarding incomplete). A genuine query failure once a DB exists must surface
 * as an error, not be silently rendered as "no data" (rule #8: don't mask
 * errors), so it is deliberately NOT caught here.
 */
async function readForFamily<T>(
  read: (database: Database, familyId: string) => Promise<T>,
  empty: T,
): Promise<T> {
  if (!process.env.DATABASE_URL) return empty;
  const database = defaultDb();
  const familyId = await currentFamilyId(database);
  if (!familyId) return empty;
  return read(database, familyId);
}

export function loadDrafts(): Promise<DraftView[]> {
  return readForFamily(async (database, familyId) => {
    const rows = await database
      .select()
      .from(schema.actions)
      .where(
        and(
          eq(schema.actions.familyId, familyId),
          eq(schema.actions.userVisibleState, 'drafted_for_approval'),
        ),
      )
      .orderBy(desc(schema.actions.draftedAt));
    return rows.map(toDraftView);
  }, []);
}

export interface DigestData {
  tally: DigestTally;
  entries: DigestEntryView[];
}

const EMPTY_DIGEST: DigestData = {
  tally: { handled: 0, awaiting: 0, needsYou: 0 },
  entries: [],
};

export function loadDigest(): Promise<DigestData> {
  return readForFamily(async (database, familyId) => {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const rows = await database
      .select()
      .from(schema.actions)
      .where(
        and(
          eq(schema.actions.familyId, familyId),
          gte(schema.actions.draftedAt, startOfDay),
        ),
      )
      .orderBy(desc(schema.actions.draftedAt));
    const entries = rows
      .map(toDigestEntry)
      .filter((entry): entry is DigestEntryView => entry !== null);
    return { tally: toDigestTally(rows), entries };
  }, EMPTY_DIGEST);
}

export function loadTrail(): Promise<TrailView[]> {
  return readForFamily(async (database, familyId) => {
    const rows = await database
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.familyId, familyId))
      .orderBy(desc(schema.auditLog.occurredAt))
      .limit(50);
    return rows.map(toTrailView);
  }, []);
}
