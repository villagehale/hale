import { type Database, schema } from '@hale/db';
import { deriveStage } from '@hale/types';
import { desc, eq } from 'drizzle-orm';
import { db as defaultDb } from '~/lib/db';
import { currentFamilyId } from '~/lib/family';
import { countEndorsementsForCandidates, listFamilyEndorsedCandidateIds } from './endorse';
import {
  type RoutineProposalView,
  type VillageCandidateView,
  toRoutineProposalView,
  toVillageCandidateView,
} from './mappers';

/**
 * Mirrors dashboard/queries.ts: the village page runs both in a credential-less
 * preview (no DATABASE_URL, no Auth.js session) and in a real authed session, and lands
 * both on the same calm empty state for the two EXPECTED boundaries only — no
 * DATABASE_URL (preview) or no resolved family (unauthed / onboarding
 * incomplete). A genuine query failure once a DB exists must surface as an error
 * (rule #8: don't mask errors), so it is deliberately NOT caught here.
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

export interface VillageData {
  candidates: VillageCandidateView[];
  routine: RoutineProposalView | null;
}

const EMPTY_VILLAGE: VillageData = { candidates: [], routine: null };

/**
 * Reads ONE resolved family's discovered candidates + latest routine proposal,
 * teen-safe. Split out of loadVillage so the agent-ranked feed can reuse the exact
 * same teen-redacted candidate read (rule #1) against an already-resolved
 * family/database — the redaction lives in one place, the feed never re-implements
 * it. Teen attribution is derived LIVE from date_of_birth via deriveStage (never
 * stored); a candidate/routine item tied to a 13+ child is redacted at the mapper.
 */
export async function readVillage(database: Database, familyId: string): Promise<VillageData> {
  const children = await database
    .select({
      id: schema.children.id,
      dateOfBirth: schema.children.dateOfBirth,
    })
    .from(schema.children)
    .where(eq(schema.children.familyId, familyId));

  const teenChildIds = new Set(
    children.filter((c) => deriveStage(c.dateOfBirth) === 'teenager').map((c) => c.id),
  );

  const candidateRows = await database
    .select()
    .from(schema.villageCandidates)
    .where(eq(schema.villageCandidates.familyId, familyId))
    .orderBy(
      desc(schema.villageCandidates.confidence),
      desc(schema.villageCandidates.discoveredAt),
    );

  const routineRows = await database
    .select()
    .from(schema.routineProposals)
    .where(eq(schema.routineProposals.familyId, familyId))
    .orderBy(desc(schema.routineProposals.weekOf))
    .limit(1);

  const candidateIds = candidateRows.map((row) => row.id);
  const [endorsementCounts, familyEndorsed] = await Promise.all([
    countEndorsementsForCandidates(database, candidateIds),
    listFamilyEndorsedCandidateIds(database, familyId),
  ]);

  const candidates = candidateRows.map((row) =>
    toVillageCandidateView(row, row.childId !== null && teenChildIds.has(row.childId), {
      endorsementCount: endorsementCounts.get(row.id) ?? 0,
      endorsedByFamily: familyEndorsed.has(row.id),
    }),
  );
  const routine = routineRows[0] ? toRoutineProposalView(routineRows[0], teenChildIds) : null;

  return { candidates, routine };
}

/**
 * The credential-less-preview / unauthed boundary wrapper around readVillage: the
 * village page runs both in a preview (no DATABASE_URL, no session) and a real
 * authed session, landing both on the same calm empty state for the two EXPECTED
 * boundaries only. A genuine query failure once a DB exists must surface (rule #8).
 */
export function loadVillage(): Promise<VillageData> {
  return readForFamily(readVillage, EMPTY_VILLAGE);
}
