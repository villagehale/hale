import { cache } from 'react';
import { type Database, schema } from '@hale/db';
import { and, desc, eq, ne } from 'drizzle-orm';
import { db as defaultDb } from '~/lib/db';
import { currentFamilyId } from '~/lib/family';
import { type FamilyBasicsView, toFamilyBasics } from './family-basics';
import { type FamilyHeaderView, toFamilyHeader } from './family-header';
import { type FamilyMembersView, toFamilyMembersView } from './family-members';
import { type ApprovalView, toApprovalView } from './approvals';
import { type HistoryActionRow, type HistoryView, toHistoryView } from './history';
import { DEFAULT_TIMEZONE } from '~/lib/format/datetime';
import { type TrailView, effectiveTeenContent } from './mappers';
import { familyHasTeenager, loadTrailForFamily, readFamilyTimezone } from './trail-query';

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
  foundingNumber: null,
  children: [],
};

/**
 * The Family page's editable basics: the family's structured (coarse) location +
 * plan tier and its children (with date_of_birth so an edit form prefills, and the
 * live-derived stage). Same empty-state degradation as the other reads: no DB or no
 * resolved family → empty basics.
 *
 * Wrapped in React `cache()` so the authed layout (account chip + child switcher +
 * top-bar location) and the page rendered inside it share one families+children read
 * per request instead of each firing the pair.
 */
export const loadFamilyBasics = cache((): Promise<FamilyBasicsView> => {
  return readForFamily(async (database, familyId) => {
    const [family] = await database
      .select({
        country: schema.families.country,
        province: schema.families.province,
        city: schema.families.city,
        postalCode: schema.families.postalCode,
        planTier: schema.families.planTier,
        intents: schema.families.intents,
        foundingNumber: schema.families.foundingNumber,
      })
      .from(schema.families)
      .where(eq(schema.families.id, familyId))
      .limit(1);

    const children = await database
      .select({
        id: schema.children.id,
        name: schema.children.name,
        lastName: schema.children.lastName,
        dateOfBirth: schema.children.dateOfBirth,
        gender: schema.children.gender,
        biologicalSex: schema.children.biologicalSex,
        interests: schema.children.interests,
      })
      .from(schema.children)
      .where(eq(schema.children.familyId, familyId))
      .orderBy(schema.children.dateOfBirth);

    return toFamilyBasics(family ?? null, children);
  }, EMPTY_FAMILY_BASICS);
});

export function loadFamilyTimezone(): Promise<string> {
  return readForFamily(readFamilyTimezone, DEFAULT_TIMEZONE);
}

export function loadTrail(): Promise<TrailView[]> {
  return readForFamily(loadTrailForFamily, []);
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

/**
 * The Approvals HISTORY list: this family's RESOLVED actions — everything past the
 * pending queue (userVisibleState != 'drafted_for_approval', so autonomous /
 * needs_human / reverted), newest-resolved first. Same joins + rule-#1 redaction as
 * loadPendingApprovals (event for teen_content, child for DOB), so a 13+ child's raw
 * payload never reaches a history row; toHistoryView reuses the live card's teen-safe
 * intent label. Same empty-state degradation: no DB or no resolved family → empty list.
 *
 * The 50-row window mirrors the pending queue and the trail; a keyset page isn't
 * wired yet (see the loader family's limit), so this shows the most recent 50.
 */
export function loadResolvedActions(): Promise<HistoryView[]> {
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
        reviewerVerdictAt: schema.actions.reviewerVerdictAt,
        draftedAt: schema.actions.draftedAt,
        userVisibleState: schema.actions.userVisibleState,
        executedAt: schema.actions.executedAt,
        revertedAt: schema.actions.revertedAt,
        revertedReason: schema.actions.revertedReason,
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
          ne(schema.actions.userVisibleState, 'drafted_for_approval'),
        ),
      )
      .orderBy(desc(schema.actions.draftedAt))
      .limit(50);
    return rows
      .map((row) => {
        // The "when" stamp is the terminal instant: executed / reverted / reviewer
        // verdict, falling back to draftedAt (always present) — a display default at
        // an explicit boundary, not a masked null.
        const resolvedAt =
          row.revertedAt ?? row.executedAt ?? row.reviewerVerdictAt ?? row.draftedAt;
        const historyRow: HistoryActionRow = {
          id: row.id,
          actionType: row.actionType,
          payload: row.payload,
          reviewerVerdict: row.reviewerVerdict,
          draftedAt: row.draftedAt,
          teenContent: effectiveTeenContent(row.teenContent, row.childDob ?? null, familyHasTeen),
          childId: row.childId ?? null,
          childLabel: row.childName ?? null,
          userVisibleState: row.userVisibleState as HistoryActionRow['userVisibleState'],
          executedAt: row.executedAt,
          revertedReason: row.revertedReason,
          resolvedAt,
        };
        return { view: toHistoryView(historyRow, timeZone), resolvedAt };
      })
      // Newest RESOLVED first — the query orders by draftedAt (indexed), but the
      // resolved instant is what the list reads by, so re-sort on it here.
      .sort((a, b) => b.resolvedAt.getTime() - a.resolvedAt.getTime())
      .map((r) => r.view);
  }, []);
}
