import { type CompanionView, companionForChild } from '@hale/types';
import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { db as defaultDb } from '~/lib/db';
import { currentFamilyId } from '~/lib/family';

/** One child's companion view, carrying the child id for stable list keys. */
export interface ChildCompanionView extends CompanionView {
  id: string;
}

/**
 * The companion page runs in a credential-less preview (no DATABASE_URL, no
 * Clerk) and in a real authed session, landing both on the same calm empty
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

  return rows.map((row) => ({
    id: row.id,
    ...companionForChild({ dateOfBirth: row.dateOfBirth, name: row.name }),
  }));
}
