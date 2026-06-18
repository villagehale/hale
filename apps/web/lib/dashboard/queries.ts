import { type Database, schema } from '@hale/db';
import { and, desc, eq, gte, isNull, sql } from 'drizzle-orm';
import { db as defaultDb } from '~/lib/db';
import { currentFamilyId } from '~/lib/family';
import { type ConnectedSourceMap, toConnectedSourceMap } from './connected';
import { type FamilyHeaderView, toFamilyHeader } from './family-header';
import { type FamilyMembersView, toFamilyMembersView } from './family-members';
import {
  type DigestEntryView,
  type DigestTally,
  type DraftView,
  type LiveSignalView,
  type MemoryFactView,
  type TrailView,
  toDigestEntry,
  toDigestTally,
  toDraftView,
  toLiveSignal,
  toMemoryFactView,
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
      .where(and(eq(schema.actions.familyId, familyId), gte(schema.actions.draftedAt, startOfDay)))
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

const EMPTY_FAMILY_MEMBERS: FamilyMembersView = { primary: null, coParent: null };

/**
 * The family's parents (primary + co-parent), joined to their user identity, for
 * the settings "your family" block. Same empty-state degradation as the other
 * reads: no DB or no resolved family → both slots null.
 */
export function loadFamilyMembers(): Promise<FamilyMembersView> {
  return readForFamily(async (database, familyId) => {
    const rows = await database
      .select({
        name: schema.users.name,
        email: schema.users.email,
        role: schema.familyMembers.role,
      })
      .from(schema.familyMembers)
      .innerJoin(schema.users, eq(schema.familyMembers.userId, schema.users.id))
      .where(eq(schema.familyMembers.familyId, familyId));
    return toFamilyMembersView(rows);
  }, EMPTY_FAMILY_MEMBERS);
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

/**
 * The recent signal stream: events Hale noticed, each with its drafted action (if
 * one exists), newest first. A LEFT JOIN keeps observe-only events that never
 * produced an action — those render as quiet notes. teen_content lives on the
 * event itself, so the mapper redacts directly from the event row (rule #1).
 */
export function loadLiveSignals(): Promise<LiveSignalView[]> {
  return readForFamily(async (database, familyId) => {
    const rows = await database
      .select({ event: schema.events, action: schema.actions })
      .from(schema.events)
      .leftJoin(schema.actions, eq(schema.actions.eventId, schema.events.id))
      .where(eq(schema.events.familyId, familyId))
      .orderBy(desc(schema.events.receivedAt))
      .limit(50);
    return rows.map((row) => toLiveSignal(row.event, row.action));
  }, []);
}

/**
 * The family's currently-valid memory facts (valid_until IS NULL — superseded
 * facts are tombstoned, not deleted), newest first. No teen gate here: a fact's
 * teen-sensitivity is governed upstream by what the inferencer is permitted to
 * write, not at read time.
 */
export function loadMemoryFacts(): Promise<MemoryFactView[]> {
  return readForFamily(async (database, familyId) => {
    const rows = await database
      .select()
      .from(schema.familyMemoryFacts)
      .where(
        and(
          eq(schema.familyMemoryFacts.familyId, familyId),
          isNull(schema.familyMemoryFacts.validUntil),
        ),
      )
      .orderBy(desc(schema.familyMemoryFacts.createdAt));
    return rows.map(toMemoryFactView);
  }, []);
}

/**
 * The family's integration rows, keyed by provider, so the connected page can
 * show each catalogued source's real status instead of a hardcoded "connected".
 * Providers with no row are absent from the map and read as not-yet-connected.
 */
export function loadConnectedSources(): Promise<ConnectedSourceMap> {
  return readForFamily(async (database, familyId) => {
    const rows = await database
      .select({
        provider: schema.integrations.provider,
        status: schema.integrations.status,
      })
      .from(schema.integrations)
      .where(eq(schema.integrations.familyId, familyId));
    return toConnectedSourceMap(rows);
  }, {});
}
