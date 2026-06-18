import { type Database, schema } from '@hale/db';
import { and, desc, eq, sql } from 'drizzle-orm';
import { db as defaultDb } from '~/lib/db';
import { currentFamilyId } from '~/lib/family';
import { type FamilyBasicsView, toFamilyBasics } from './family-basics';
import { type FamilyHeaderView, toFamilyHeader } from './family-header';
import { type FamilyMembersView, toFamilyMembersView } from './family-members';
import { type TrailView, toTrailView } from './mappers';

/**
 * The remaining family-scoped reads (the family band, the Family page, and the
 * History trail) run in a credential-less preview (no DATABASE_URL, no Clerk) for
 * screenshots, AND in a real authed session. `readForFamily` lands both worlds on
 * the same calm empty state — but only for the two EXPECTED boundaries: no
 * DATABASE_URL (preview), or no resolved family (unauthed / onboarding
 * incomplete). A genuine query failure once a DB exists must surface as an error,
 * not be silently rendered as "no data" (rule #8: don't mask errors), so it is
 * deliberately NOT caught here.
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
 * the Family page "your family" block. Same empty-state degradation as the other
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

const EMPTY_FAMILY_BASICS: FamilyBasicsView = { areaCoarse: null, children: [] };

/**
 * The Family page's editable basics: the family's coarse area and its children
 * (with date_of_birth so an edit form prefills, and the live-derived stage).
 * Same empty-state degradation as the other reads: no DB or no resolved family →
 * empty basics.
 */
export function loadFamilyBasics(): Promise<FamilyBasicsView> {
  return readForFamily(async (database, familyId) => {
    const [family] = await database
      .select({ areaCoarse: schema.families.areaCoarse })
      .from(schema.families)
      .where(eq(schema.families.id, familyId))
      .limit(1);

    const children = await database
      .select({
        id: schema.children.id,
        name: schema.children.name,
        dateOfBirth: schema.children.dateOfBirth,
      })
      .from(schema.children)
      .where(eq(schema.children.familyId, familyId))
      .orderBy(schema.children.dateOfBirth);

    return toFamilyBasics(family?.areaCoarse ?? null, children);
  }, EMPTY_FAMILY_BASICS);
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
