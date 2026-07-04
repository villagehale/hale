import { type CompanionView, companionForChild } from '@hale/types';
import { type Database, schema } from '@hale/db';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db as defaultDb } from '~/lib/db';
import { currentFamilyId } from '~/lib/family';
import { buildDoneByChild, doneForChild } from './done-markers.js';
import { HEALTH_DONE_EPISODE, MILESTONE_EPISODE } from './log-types.js';

/** One child's companion view, carrying the child id for stable list keys. */
export interface ChildCompanionView extends CompanionView {
  id: string;
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

  const rows = await database
    .select({
      id: schema.children.id,
      name: schema.children.name,
      dateOfBirth: schema.children.dateOfBirth,
    })
    .from(schema.children)
    .where(eq(schema.children.familyId, familyId))
    .orderBy(schema.children.dateOfBirth);

  const doneByChild = await loadDoneByChild(database, familyId);

  return rows.map((row) => ({
    id: row.id,
    ...companionForChild(
      { dateOfBirth: row.dateOfBirth, name: row.name },
      new Date(),
      doneForChild(doneByChild, row.id),
    ),
  }));
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
