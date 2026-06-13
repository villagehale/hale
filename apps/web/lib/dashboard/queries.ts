import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { type Database, schema } from '@hearth/db';
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
import { type FamilyHeaderView, toFamilyHeader } from './family-header';

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
      .select({ action: schema.actions, teenContent: schema.events.teenContent })
      .from(schema.actions)
      .innerJoin(schema.events, eq(schema.actions.eventId, schema.events.id))
      .where(
        and(
          eq(schema.actions.familyId, familyId),
          eq(schema.actions.userVisibleState, 'drafted_for_approval'),
        ),
      )
      .orderBy(desc(schema.actions.draftedAt));
    return rows.map((row) => toDraftView(row.action, row.teenContent));
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
      .select({ action: schema.actions, teenContent: schema.events.teenContent })
      .from(schema.actions)
      .innerJoin(schema.events, eq(schema.actions.eventId, schema.events.id))
      .where(
        and(
          eq(schema.actions.familyId, familyId),
          gte(schema.actions.draftedAt, startOfDay),
        ),
      )
      .orderBy(desc(schema.actions.draftedAt));
    const entries = rows
      .map((row) => toDigestEntry(row.action, row.teenContent))
      .filter((entry): entry is DigestEntryView => entry !== null);
    return { tally: toDigestTally(rows.map((row) => row.action)), entries };
  }, EMPTY_DIGEST);
}

const EMPTY_FAMILY_HEADER: FamilyHeaderView = { children: [], stages: [] };

/**
 * The family's children with their live-derived stages, for the header that
 * tells the rest of the experience which stage(s) to tailor to. Same empty-state
 * degradation as the other reads: no DB or no resolved family → empty header.
 */
export function loadFamilyHeader(): Promise<FamilyHeaderView> {
  return readForFamily(async (database, familyId) => {
    const rows = await database
      .select({
        id: schema.children.id,
        name: schema.children.name,
        dateOfBirth: schema.children.dateOfBirth,
      })
      .from(schema.children)
      .where(eq(schema.children.familyId, familyId))
      .orderBy(schema.children.dateOfBirth);
    return toFamilyHeader(rows);
  }, EMPTY_FAMILY_HEADER);
}

export function loadTrail(): Promise<TrailView[]> {
  return readForFamily(async (database, familyId) => {
    // Rule #1: a trail row's teen_content lives two hops away — audit_log targets
    // an actions row (target_table='actions', target_id=action uuid), which points
    // at the event that carries the flag. We cast actions.id → text (always safe)
    // to match the text target_id, rather than parsing target_id → uuid (which
    // would error on any non-uuid target_id). LEFT JOINs keep rows that don't
    // resolve to an action/event (other target tables) — those carry teenContent
    // = null/false and render in full, the documented trail boundary: we redact
    // exactly when a row resolves to teen_content, never claiming to cover targets
    // we can't tie.
    const rows = await database
      .select({ entry: schema.auditLog, teenContent: schema.events.teenContent })
      .from(schema.auditLog)
      .leftJoin(
        schema.actions,
        and(
          eq(schema.auditLog.targetTable, 'actions'),
          eq(sql`${schema.actions.id}::text`, schema.auditLog.targetId),
        ),
      )
      .leftJoin(schema.events, eq(schema.actions.eventId, schema.events.id))
      .where(eq(schema.auditLog.familyId, familyId))
      .orderBy(desc(schema.auditLog.occurredAt))
      .limit(50);
    return rows.map((row) => toTrailView(row.entry, row.teenContent ?? false));
  }, []);
}
