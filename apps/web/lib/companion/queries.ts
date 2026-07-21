import { type CompanionView, companionForChild } from '@hale/types';
import { type Database, schema } from '@hale/db';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db as defaultDb } from '~/lib/db';
import { resolveChildAvatarUrl } from '~/lib/family/child-avatar';
import { currentFamilyId } from '~/lib/family';
import { buildDoneByChild, doneForChild } from './done-markers.js';
import { HEALTH_DONE_EPISODE, MILESTONE_EPISODE } from './log-types.js';

/** One child's companion view, carrying the child id for stable list keys and
 * the raw date of birth (PII) so a header can echo it and health-item due dates
 * can be derived from the same source-of-truth the schedule is keyed on. Plus the
 * optional last name (for the header monogram — first+last, never a parent's
 * surname) and the pre-signed avatar URL (null → initials fallback). */
export interface ChildCompanionView extends CompanionView {
  id: string;
  dateOfBirth: string;
  lastName: string | null;
  avatarUrl: string | null;
}

/**
 * The companion page runs in a credential-less preview (no DATABASE_URL, no
 * Auth.js session) and in a real authed session, landing both on the same calm empty
 * state for the two EXPECTED boundaries only — no DATABASE_URL (preview) or no
 * resolved family (unauthed / onboarding incomplete). A genuine query failure
 * once a DB exists must surface (rule #8), so it is deliberately NOT caught.
 *
 * Companion guidance is derived LIVE per child from date_of_birth via
 * companionForChild — never stored — so it always reflects the child's current
 * age and stage.
 */
export async function loadCompanion(): Promise<ChildCompanionView[]> {
  if (!process.env.DATABASE_URL) return [];
  const database = defaultDb();
  const familyId = await currentFamilyId(database);
  if (!familyId) return [];
  return companionForFamily(familyId, database);
}

/**
 * The per-child companion views for an EXPLICIT family — the session-less variant
 * loadCompanion delegates to, so a cron (which has a familyId, not a session) reads
 * the same age-derived health items + done markers without duplicating the query.
 * Every read is keyed on familyId (rule #1: family-scoped); teen redaction is the
 * caller's job on the derived view, since the raw DOB is needed here to derive the
 * schedule.
 */
export async function companionForFamily(
  familyId: string,
  database: Database,
  now: Date = new Date(),
): Promise<ChildCompanionView[]> {
  // The children roster and the done-episodes map are independent family-scoped
  // reads — fetch them together rather than serializing the two latencies.
  const [rows, doneByChild] = await Promise.all([
    database
      .select({
        id: schema.children.id,
        name: schema.children.name,
        lastName: schema.children.lastName,
        dateOfBirth: schema.children.dateOfBirth,
        avatarPath: schema.children.avatarPath,
        avatarUpdatedAt: schema.children.avatarUpdatedAt,
      })
      .from(schema.children)
      .where(eq(schema.children.familyId, familyId))
      .orderBy(schema.children.dateOfBirth),
    loadDoneByChild(database, familyId),
  ]);

  // Resolve each child's private-bucket avatar key to a signed URL (with the
  // cache-buster) so the hub header renders the photo; only children WITH a photo
  // incur a sign, and an unsignable one degrades to null → initials.
  return Promise.all(
    rows.map(async (row) => ({
      id: row.id,
      dateOfBirth: row.dateOfBirth,
      lastName: row.lastName,
      avatarUrl: await resolveChildAvatarUrl(row.avatarPath, row.avatarUpdatedAt),
      ...companionForChild(
        { dateOfBirth: row.dateOfBirth, name: row.name },
        now,
        doneForChild(doneByChild, row.id),
      ),
    })),
  );
}

/** The per-child inputs the WHO growth read needs beyond the companion view: the
 * SEX and gestation the standard is keyed on. Kept SERVER-side (never forwarded to
 * the client, rule #1) — the page derives the header stats here and passes only the
 * neutral derived percentile/band on. */
export interface ChildGrowthInput {
  id: string;
  dateOfBirth: string;
  biologicalSex: string | null;
  gestationalWeeks: number | null;
}

/**
 * The family's children with the sex + gestation the WHO growth standard needs.
 * Same empty-state degradation as loadCompanion (no DB / no family → []). Separate
 * from loadCompanion so the sensitive sex column stays out of the client-facing
 * ChildCompanionView and is read only where the growth math runs.
 */
export async function loadChildrenGrowthInputs(): Promise<ChildGrowthInput[]> {
  if (!process.env.DATABASE_URL) return [];
  const database = defaultDb();
  const familyId = await currentFamilyId(database);
  if (!familyId) return [];
  return database
    .select({
      id: schema.children.id,
      dateOfBirth: schema.children.dateOfBirth,
      biologicalSex: schema.children.biologicalSex,
      gestationalWeeks: schema.children.gestationalWeeks,
    })
    .from(schema.children)
    .where(eq(schema.children.familyId, familyId));
}

/**
 * Reads the family's live milestone / health-done episodes and folds them into the
 * per-child "already done" map (buildDoneByChild). Only the two episode types that
 * mark a curated item done are read — the done state is the presence of these rows,
 * so no schema column is needed. deletedAt-filtered: a removed log un-marks its item.
 */
async function loadDoneByChild(database: Database, familyId: string) {
  const rows = await database
    .select({
      childId: schema.familyMemoryEpisodes.childId,
      episodeType: schema.familyMemoryEpisodes.episodeType,
      payload: schema.familyMemoryEpisodes.payload,
    })
    .from(schema.familyMemoryEpisodes)
    .where(
      and(
        eq(schema.familyMemoryEpisodes.familyId, familyId),
        isNull(schema.familyMemoryEpisodes.deletedAt),
        inArray(schema.familyMemoryEpisodes.episodeType, [MILESTONE_EPISODE, HEALTH_DONE_EPISODE]),
      ),
    );
  return buildDoneByChild(rows);
}
