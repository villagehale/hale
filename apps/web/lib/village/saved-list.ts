import { type Database, schema } from '@hale/db';
import { deriveStage } from '@hale/types';
import { desc, eq } from 'drizzle-orm';
import { listFamilyAcceptedCandidateIds } from './accept';
import { countEndorsementsForCandidates, listFamilyEndorsedCandidateIds } from './endorse';
import { type VillageCandidateView, toVillageCandidateView } from './mappers';

/**
 * The family's privately-saved candidates ("I'm interested"), newest-save-first,
 * for the More → Saved screen. Reads the village_saves join, then the candidate
 * rows, applying the SAME teen redaction the feed does (rule #1): a candidate tied
 * to a 13+ child surfaces only its category, its raw fields nulled at the mapper.
 *
 * Unlike the standing feed this does NOT filter supersededAt — a family that saved
 * a candidate should keep seeing it in Saved even after a newer discovery run
 * soft-retires it from the live feed. Every returned view carries saved:true (they
 * are all saved by construction), so the card/sheet render the filled bookmark.
 */
export async function readSavedVillageCandidates(
  database: Database,
  familyId: string,
): Promise<VillageCandidateView[]> {
  const children = await database
    .select({ id: schema.children.id, dateOfBirth: schema.children.dateOfBirth })
    .from(schema.children)
    .where(eq(schema.children.familyId, familyId));

  const teenChildIds = new Set(
    children.filter((c) => deriveStage(c.dateOfBirth) === 'teenager').map((c) => c.id),
  );

  const rows = await database
    .select({ candidate: schema.villageCandidates })
    .from(schema.villageSaves)
    .innerJoin(
      schema.villageCandidates,
      eq(schema.villageSaves.candidateId, schema.villageCandidates.id),
    )
    .where(eq(schema.villageSaves.familyId, familyId))
    .orderBy(desc(schema.villageSaves.createdAt));

  const candidateIds = rows.map((row) => row.candidate.id);
  const [endorsementCounts, familyEndorsed, familyAccepted] = await Promise.all([
    countEndorsementsForCandidates(database, candidateIds),
    listFamilyEndorsedCandidateIds(database, familyId),
    listFamilyAcceptedCandidateIds(database, familyId),
  ]);

  return rows.map((row) =>
    toVillageCandidateView(
      row.candidate,
      row.candidate.childId !== null && teenChildIds.has(row.candidate.childId),
      {
        endorsementCount: endorsementCounts.get(row.candidate.id) ?? 0,
        endorsedByFamily: familyEndorsed.has(row.candidate.id),
        accepted: familyAccepted.has(row.candidate.id),
        saved: true,
      },
    ),
  );
}
