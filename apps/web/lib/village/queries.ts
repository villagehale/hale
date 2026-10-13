import { type Database, schema } from '@hale/db';
import { deriveStage } from '@hale/types';
import { and, eq, inArray } from 'drizzle-orm';
import { db as defaultDb } from '~/lib/db';
import { currentFamilyId } from '~/lib/family';
import { listFamilyAcceptedCandidateIds } from './accept';
import { type SavedAreaLabel, readActiveArea } from './areas';
import { defaultDiscoverDeps, discoverForFamily } from './discover';
import { countEndorsementsForCandidates, listFamilyEndorsedCandidateIds } from './endorse';
import { type VillageCandidateView, toVillageCandidateView } from './mappers';
import { listFamilySavedCandidateIds } from './save';
import { readSavedVillageCandidates } from './saved-list';
import type { Season } from './visibility';

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
}

const EMPTY_VILLAGE: VillageData = { candidates: [] };

/** Live search hints for this operation, not a stored feed selector. */
export interface VillageReadOptions {
  subject?: string;
  searchSeason?: Season;
}

/**
 * Reads ONE resolved family's discovered candidates, teen-safe. Split out of
 * loadVillage so the agent-ranked feed can reuse the exact same teen-redacted
 * candidate read (rule #1) against an already-resolved family/database — the
 * redaction lives in one place, the feed never re-implements it. Teen attribution
 * is derived LIVE from date_of_birth via deriveStage (never stored); a candidate
 * tied to a 13+ child is redacted at the mapper.
 */
export async function readVillage(
  database: Database,
  familyId: string,
  opts?: VillageReadOptions,
): Promise<VillageData> {
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

  const result = await discoverForFamily(familyId, database, defaultDiscoverDeps(), opts);
  const candidateRows =
    result.status === 'discovered' && result.offeredIds.length > 0
      ? await database
          .select()
          .from(schema.familyActivityHistory)
          .where(
            and(
              eq(schema.familyActivityHistory.familyId, familyId),
              inArray(schema.familyActivityHistory.id, result.offeredIds),
            ),
          )
      : [];

  const candidateIds = candidateRows.map((row) => row.id);
  const [endorsementCounts, familyEndorsed, familyAccepted, familySaved] = await Promise.all([
    countEndorsementsForCandidates(database, candidateIds),
    listFamilyEndorsedCandidateIds(database, familyId),
    listFamilyAcceptedCandidateIds(database, familyId),
    listFamilySavedCandidateIds(database, familyId),
  ]);

  const candidates = candidateRows.map((row) =>
    toVillageCandidateView(row, row.childId !== null && teenChildIds.has(row.childId), {
      endorsementCount: endorsementCounts.get(row.id) ?? 0,
      endorsedByFamily: familyEndorsed.has(row.id),
      accepted: familyAccepted.has(row.id),
      saved: familySaved.has(row.id),
    }),
  );
  return { candidates };
}

/**
 * The credential-less-preview / unauthed boundary wrapper around readVillage: the
 * village page runs both in a preview (no DATABASE_URL, no session) and a real
 * authed session, landing both on the same calm empty state for the two EXPECTED
 * boundaries only. A genuine query failure once a DB exists must surface (rule #8).
 */
export function loadVillage(opts?: VillageReadOptions): Promise<VillageData> {
  return readForFamily(
    (database, familyId) => readVillage(database, familyId, opts),
    EMPTY_VILLAGE,
  );
}

/**
 * The family's privately-saved candidates for the More → Saved screen, behind the
 * same preview/unauthed boundary as loadVillage: no DATABASE_URL (preview) or no
 * resolved family → an empty list. A genuine query failure surfaces (rule #8).
 */
export function loadSavedVillageCandidates(): Promise<VillageCandidateView[]> {
  return readForFamily((database, familyId) => readSavedVillageCandidates(database, familyId), []);
}

/**
 * The family's ACTIVE saved area label for the Village header, behind the same
 * preview/unauthed boundary as loadVillage: no DATABASE_URL (preview) or no
 * resolved family → null (the header shows no location). Falls back to the legacy
 * family city/province when no saved-area row exists (back-compat).
 */
export function loadActiveArea(): Promise<SavedAreaLabel | null> {
  return readForFamily((database, familyId) => readActiveArea(database, familyId), null);
}

/**
 * Reads ONE candidate by id for the native pushed Activity route, teen-safe. Scoped
 * to the resolving family (a foreign id → null, never a cross-family read) and
 * DELIBERATELY not visibility-gated: a saved / accepted candidate that has aged out
 * of the standing feed (out of season, superseded) must still resolve so its detail
 * route opens from Saved / the week. Teen attribution is derived LIVE from the
 * child's date_of_birth and redacted at the SAME mapper the feed uses (rule #1), so
 * a 13+ child's candidate returns the locked view — the raw fields never reach it.
 */
export async function readVillageCandidateById(
  database: Database,
  familyId: string,
  id: string,
): Promise<VillageCandidateView | null> {
  const rows = await database
    .select()
    .from(schema.familyActivityHistory)
    .where(
      and(
        eq(schema.familyActivityHistory.id, id),
        eq(schema.familyActivityHistory.familyId, familyId),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;

  const teenAttributed =
    row.childId !== null && (await isTeenChild(database, familyId, row.childId));

  const [endorsementCounts, familyEndorsed, familyAccepted, familySaved] = await Promise.all([
    countEndorsementsForCandidates(database, [id]),
    listFamilyEndorsedCandidateIds(database, familyId),
    listFamilyAcceptedCandidateIds(database, familyId),
    listFamilySavedCandidateIds(database, familyId),
  ]);

  return toVillageCandidateView(
    row,
    teenAttributed,
    {
      endorsementCount: endorsementCounts.get(id) ?? 0,
      endorsedByFamily: familyEndorsed.has(id),
      accepted: familyAccepted.has(id),
      saved: familySaved.has(id),
    },
    true,
  );
}

/** Whether a candidate's child is a 13+ teen (rule #1), derived live from DOB. */
async function isTeenChild(
  database: Database,
  familyId: string,
  childId: string,
): Promise<boolean> {
  const rows = await database
    .select({ dateOfBirth: schema.children.dateOfBirth })
    .from(schema.children)
    .where(and(eq(schema.children.id, childId), eq(schema.children.familyId, familyId)))
    .limit(1);
  const dob = rows[0]?.dateOfBirth;
  return dob !== undefined && deriveStage(dob) === 'teenager';
}

/**
 * The preview/unauthed-boundary wrapper around readVillageCandidateById for the
 * mobile Activity-by-id route: no DATABASE_URL (preview) or no resolved family →
 * null (the route then renders its honest empty state). A genuine query failure
 * once a DB exists surfaces (rule #8).
 */
export function loadVillageCandidateById(id: string): Promise<VillageCandidateView | null> {
  return readForFamily(
    (database, familyId) => readVillageCandidateById(database, familyId, id),
    null,
  );
}
