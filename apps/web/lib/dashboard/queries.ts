import { type Database, schema } from '@hale/db';
import { deriveStage } from '@hale/types';
import { and, desc, eq, sql } from 'drizzle-orm';
import { db as defaultDb } from '~/lib/db';
import { currentFamilyId } from '~/lib/family';
import { type FamilyBasicsView, toFamilyBasics } from './family-basics';
import { type FamilyHeaderView, toFamilyHeader } from './family-header';
import { type FamilyMembersView, toFamilyMembersView } from './family-members';
import { type ApprovalView, toApprovalView } from './approvals';
import { DEFAULT_TIMEZONE } from '~/lib/format/datetime';
import {
  type ActorResolver,
  type TrailView,
  effectiveTeenContent,
  toTrailView,
} from './mappers';

/**
 * The remaining family-scoped reads (the family band, the Family page, and the
 * History trail) run in a credential-less preview (no DATABASE_URL, no Auth.js session) for
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

const EMPTY_FAMILY_BASICS: FamilyBasicsView = {
  location: { country: null, province: null, city: null, postalCode: null },
  planTier: 'free',
  intents: [],
  children: [],
};

/**
 * The Family page's editable basics: the family's structured (coarse) location +
 * plan tier and its children (with date_of_birth so an edit form prefills, and the
 * live-derived stage). Same empty-state degradation as the other reads: no DB or no
 * resolved family → empty basics.
 */
export function loadFamilyBasics(): Promise<FamilyBasicsView> {
  return readForFamily(async (database, familyId) => {
    const [family] = await database
      .select({
        country: schema.families.country,
        province: schema.families.province,
        city: schema.families.city,
        postalCode: schema.families.postalCode,
        planTier: schema.families.planTier,
        intents: schema.families.intents,
      })
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

    return toFamilyBasics(family ?? null, children);
  }, EMPTY_FAMILY_BASICS);
}

/**
 * The family's display name, for the sidebar account chip's second line (Hale's
 * two-parent identity). Same empty-state degradation as the other reads: no DB or
 * no resolved family → null, and the chip falls back to a neutral label.
 */
export function loadFamilyName(): Promise<string | null> {
  return readForFamily(async (database, familyId) => {
    const [family] = await database
      .select({ displayName: schema.families.displayName })
      .from(schema.families)
      .where(eq(schema.families.id, familyId))
      .limit(1);
    return family?.displayName ?? null;
  }, null);
}

/**
 * The family's display timezone — the primary parent's `users.timezone` — for the
 * time layer, so every stored instant renders in the family's zone rather than the
 * server's (Vercel = UTC). Falls back to DEFAULT_TIMEZONE (the schema default) when
 * there's no DB, no resolved family, or no primary parent yet. Mirrors the digest's
 * recipient join (role = 'primary_parent').
 */
async function readFamilyTimezone(database: Database, familyId: string): Promise<string> {
  const [row] = await database
    .select({ timezone: schema.users.timezone })
    .from(schema.familyMembers)
    .innerJoin(schema.users, eq(schema.familyMembers.userId, schema.users.id))
    .where(
      and(
        eq(schema.familyMembers.familyId, familyId),
        eq(schema.familyMembers.role, 'primary_parent'),
      ),
    )
    .limit(1);
  return row?.timezone ?? DEFAULT_TIMEZONE;
}

export function loadFamilyTimezone(): Promise<string> {
  return readForFamily(readFamilyTimezone, DEFAULT_TIMEZONE);
}

/**
 * Whether the family has any child currently in the teenager stage (deriveStage
 * boundary 156mo). Used as the rule-#1 double-miss fallback on the parent-facing
 * surfaces: when a row resolves to no child, redact its raw content if the family
 * has a teen (effectiveTeenContent's last clause).
 */
async function familyHasTeenager(database: Database, familyId: string): Promise<boolean> {
  const rows = await database
    .select({ dateOfBirth: schema.children.dateOfBirth })
    .from(schema.children)
    .where(eq(schema.children.familyId, familyId));
  return rows.some((c) => deriveStage(c.dateOfBirth) === 'teenager');
}

/**
 * Builds the trail's actor resolver from the family's member set: a stored
 * `audit_log.actor` uuid that MATCHES a member resolves to that member's role
 * ('you' for the primary, 'co-parent' otherwise); `'system'`, an agent-run uuid,
 * and any UNKNOWN uuid all resolve to Hale. This is the structural guardrail for
 * the actor rule — an id the family doesn't own is NEVER attributed to a human,
 * so Hale's own (agent-run) work and a departed user's actions can't masquerade
 * as the parent reading the trail.
 */
async function buildActorResolver(
  database: Database,
  familyId: string,
): Promise<ActorResolver> {
  const members = await database
    .select({ userId: schema.familyMembers.userId, role: schema.familyMembers.role })
    .from(schema.familyMembers)
    .where(eq(schema.familyMembers.familyId, familyId));
  const roleByUser = new Map(members.map((m) => [m.userId, m.role]));
  return (actor) => {
    const role = roleByUser.get(actor);
    if (role === undefined) return 'hale';
    return role === 'primary_parent' ? 'you' : 'co-parent';
  };
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
    //
    // Defense-in-depth (rule #1): the stored teen_content is a probabilistic
    // classifier signal, so we ALSO resolve the event's child DOB (third LEFT JOIN)
    // and OR-in the age-derived teen check — a classify miss on a 13+ child's event
    // still redacts. effectiveTeenContent does the OR.
    //
    // The double-miss fallback (family-has-teen) applies ONLY to rows that resolved
    // to an EVENT (teen_content non-null): a family-wide event the classifier didn't
    // attribute still redacts when the family has a teen. Rows that don't resolve to
    // an event (non-`actions` targets — teen_content null) keep the documented trail
    // boundary and render in full, so e.g. a consent/family-settings audit isn't
    // blanket-redacted just because the family has a teenager.
    const [familyHasTeen, timeZone, resolveActor] = await Promise.all([
      familyHasTeenager(database, familyId),
      readFamilyTimezone(database, familyId),
      buildActorResolver(database, familyId),
    ]);
    const rows = await database
      .select({
        entry: schema.auditLog,
        teenContent: schema.events.teenContent,
        childDob: schema.children.dateOfBirth,
        childName: schema.children.name,
      })
      .from(schema.auditLog)
      .leftJoin(
        schema.actions,
        and(
          eq(schema.auditLog.targetTable, 'actions'),
          eq(sql`${schema.actions.id}::text`, schema.auditLog.targetId),
        ),
      )
      .leftJoin(schema.events, eq(schema.actions.eventId, schema.events.id))
      .leftJoin(schema.children, eq(schema.events.childId, schema.children.id))
      .where(eq(schema.auditLog.familyId, familyId))
      .orderBy(desc(schema.auditLog.occurredAt))
      .limit(50);
    return rows.map((row) => {
      const resolvedToEvent = row.teenContent !== null;
      // The child tag names the attributed child by NAME — including a teenager
      // (policy 1: the parent entered it, and two teens must never both read "your
      // teen"). This is the LABEL only; the row's CONTENT is separately redacted
      // via effectiveTeenContent below. A row with no attributed child (non-`actions`
      // target, family-wide event) reads null → "whole family".
      const childLabel = row.childName ?? null;
      return toTrailView(
        row.entry,
        effectiveTeenContent(
          row.teenContent ?? false,
          row.childDob ?? null,
          resolvedToEvent && familyHasTeen,
        ),
        timeZone,
        resolveActor,
        childLabel,
      );
    });
  }, []);
}

/**
 * The Approvals queue: this family's drafted actions still awaiting a parent's
 * decision (userVisibleState = 'drafted_for_approval' — rule #4's hold for an
 * L1/L2 family). Joined to the source event for the teen-content flag, and to the
 * event's child for its DOB, so the mapper can redact a 13+ child's raw drafted
 * payload (rule #1). Defense-in-depth: the stored teen_content is a probabilistic
 * classifier signal, so effectiveTeenContent ORs it with the age-derived teen check
 * (LEFT JOIN children — null DOB when the event names no child) so a classify miss
 * on a teen's draft still redacts. The double-miss (no flag AND no attributed child)
 * falls back to familyHasTeen — every approval row resolves to an event, so a
 * family-wide draft in a family with a teen redacts. Same empty-state degradation as
 * the other reads: no DB or no resolved family → empty queue.
 */
export function loadPendingApprovals(): Promise<ApprovalView[]> {
  return readForFamily(async (database, familyId) => {
    const [familyHasTeen, timeZone] = await Promise.all([
      familyHasTeenager(database, familyId),
      readFamilyTimezone(database, familyId),
    ]);
    const rows = await database
      .select({
        id: schema.actions.id,
        actionType: schema.actions.actionType,
        payload: schema.actions.payload,
        reviewerVerdict: schema.actions.reviewerVerdict,
        draftedAt: schema.actions.draftedAt,
        teenContent: schema.events.teenContent,
        childId: schema.events.childId,
        childName: schema.children.name,
        childDob: schema.children.dateOfBirth,
      })
      .from(schema.actions)
      .innerJoin(schema.events, eq(schema.actions.eventId, schema.events.id))
      .leftJoin(schema.children, eq(schema.events.childId, schema.children.id))
      .where(
        and(
          eq(schema.actions.familyId, familyId),
          eq(schema.actions.userVisibleState, 'drafted_for_approval'),
        ),
      )
      .orderBy(desc(schema.actions.draftedAt))
      .limit(50);
    return rows.map((row) => {
      // The child tag names the attributed child by NAME — including a teenager
      // (policy 1: the parent entered it, and two teen rows must never both read
      // "your teen"). This is the LABEL only; the draft's CONTENT is redacted via
      // effectiveTeenContent (the payload/preview placeholder), so the name never
      // implies the content is visible.
      return toApprovalView(
        {
          id: row.id,
          actionType: row.actionType,
          payload: row.payload,
          reviewerVerdict: row.reviewerVerdict,
          draftedAt: row.draftedAt,
          teenContent: effectiveTeenContent(row.teenContent, row.childDob ?? null, familyHasTeen),
          childId: row.childId ?? null,
          childLabel: row.childName ?? null,
        },
        timeZone,
      );
    });
  }, []);
}
