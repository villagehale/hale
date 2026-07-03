import { schema } from '@hale/db';
import { deriveStage } from '@hale/types';
import { desc, eq } from 'drizzle-orm';
import { db as defaultDb } from '~/lib/db';
import { currentFamilyId } from '~/lib/family';

/** One parent-authored plan, joined to the child it's scoped to (if any). */
export interface AuthoredPlanView {
  id: string;
  title: string;
  notes: string | null;
  scheduledFor: string | null;
  /** null = whole family; otherwise the scoped child. */
  childId: string | null;
  /** The scoped child's given name, or null for a whole-family plan / a teen. */
  childName: string | null;
  /** True when the scoped child is 13+ (rule #1) — the name is withheld. */
  teenRedacted: boolean;
}

/**
 * Loads the family's parent-authored plans, newest first. Mirrors the village /
 * companion query degradation: the two EXPECTED boundaries (no DATABASE_URL, no
 * resolved family) return an empty list; a genuine query failure once a DB exists
 * surfaces (rule #8), so it is deliberately NOT caught.
 *
 * A teen's name (13+) is withheld from the parent-facing label (rule #1) — the
 * plan still renders, scoped to "your teen", derived live from date_of_birth.
 */
export async function loadAuthoredPlans(): Promise<AuthoredPlanView[]> {
  if (!process.env.DATABASE_URL) return [];
  const database = defaultDb();
  const familyId = await currentFamilyId(database);
  if (!familyId) return [];

  const rows = await database
    .select({
      id: schema.familyPlans.id,
      title: schema.familyPlans.title,
      notes: schema.familyPlans.notes,
      scheduledFor: schema.familyPlans.scheduledFor,
      childId: schema.familyPlans.childId,
      childName: schema.children.name,
      childDateOfBirth: schema.children.dateOfBirth,
    })
    .from(schema.familyPlans)
    .leftJoin(schema.children, eq(schema.children.id, schema.familyPlans.childId))
    .where(eq(schema.familyPlans.familyId, familyId))
    .orderBy(desc(schema.familyPlans.createdAt));

  return rows.map((row) => {
    const teenRedacted =
      row.childDateOfBirth !== null &&
      deriveStage(row.childDateOfBirth) === 'teenager';
    return {
      id: row.id,
      title: row.title,
      notes: row.notes,
      scheduledFor: row.scheduledFor?.toISOString() ?? null,
      childId: row.childId,
      childName: teenRedacted ? null : row.childName,
      teenRedacted,
    };
  });
}
