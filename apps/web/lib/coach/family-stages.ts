import { eq } from 'drizzle-orm';
import { type Database, schema } from '@hearth/db';
import { type FamilyStage, deriveFamilyStages } from '@hearth/types';

const STAGE_ORDER: readonly FamilyStage[] = ['newborn', 'toddler', 'child', 'teenager'];

/**
 * The distinct stages a family spans, derived live from its children's dates of
 * birth (rule #1: stage is the ONLY child-derived signal the coach receives — no
 * names, no raw content). Childhood-ordered, deduped. Empty when the family has
 * no children rows yet; the caller decides the default.
 */
export async function loadFamilyStages(
  familyId: string,
  database: Database,
): Promise<FamilyStage[]> {
  const rows = await database
    .select({ id: schema.children.id, dateOfBirth: schema.children.dateOfBirth })
    .from(schema.children)
    .where(eq(schema.children.familyId, familyId));

  const present = new Set(deriveFamilyStages(rows).values());
  return STAGE_ORDER.filter((stage) => present.has(stage));
}
