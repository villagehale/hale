import { type Database, schema } from '@hale/db';
import { deriveStage } from '@hale/types';
import { type SQL, and, desc, eq, isNull, or } from 'drizzle-orm';
import { readFamilyTimezone } from '~/lib/dashboard/trail-query';
import { db as defaultDb } from '~/lib/db';
import { currentFamilyId } from '~/lib/family';
import { listFamilyAcceptedCandidateIds } from './accept';
import { countEndorsementsForCandidates, listFamilyEndorsedCandidateIds } from './endorse';
import { listFamilySavedCandidateIds } from './save';
import { readSavedVillageCandidates } from './saved-list';
import {
  type RoutineProposalView,
  type VillageCandidateView,
  toRoutineProposalView,
  toVillageCandidateView,
} from './mappers';
import { type Season, orderByDate, visibleCandidates, visibleSearchCandidates } from './visibility';

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
 * How to scope the village read. Absent → the STANDING weekly feed (existing
 * behaviour). `searchSeason` → the latest SEARCH run for that season, so a parent's
 * "find fall activities" search reads back without touching the standing feed.
 */
export interface VillageReadOptions {
  searchSeason?: Season;
}

/**
 * The active-candidate WHERE for a family's feed read. Always family-scoped +
 * supersededAt-null; then scoped by run type so the standing feed and a season
 * search stay separate. Default → the STANDING feed (run_type 'standing' OR legacy
 * null, which the migration backfilled to 'standing'). With `searchSeason` → the
 * latest SEARCH run for that season (run_type 'search' AND search_season = $).
 * Extracted so the coexistence predicate is unit-tested in one place.
 */
export function villageActiveFilter(familyId: string, opts?: VillageReadOptions): SQL | undefined {
  const runScope = opts?.searchSeason
    ? and(
        eq(schema.villageCandidates.runType, 'search'),
        eq(schema.villageCandidates.searchSeason, opts.searchSeason),
      )
    : or(
        eq(schema.villageCandidates.runType, 'standing'),
        isNull(schema.villageCandidates.runType),
      );
  return and(
    eq(schema.villageCandidates.familyId, familyId),
    isNull(schema.villageCandidates.supersededAt),
    runScope,
  );
}

/**
 * Reads ONE resolved family's discovered candidates + latest routine proposal,
 * teen-safe. Split out of loadVillage so the agent-ranked feed can reuse the exact
 * same teen-redacted candidate read (rule #1) against an already-resolved
 * family/database — the redaction lives in one place, the feed never re-implements
 * it. Teen attribution is derived LIVE from date_of_birth via deriveStage (never
 * stored); a candidate/routine item tied to a 13+ child is redacted at the mapper.
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

  const currentRunRows = await database
    .select()
    .from(schema.villageCandidates)
    .where(villageActiveFilter(familyId, opts))
    .orderBy(
      desc(schema.villageCandidates.confidence),
      desc(schema.villageCandidates.discoveredAt),
    );

  // Drop past dated events, an expired (stale) run, and — on the STANDING feed only
  // — out-of-season seasonal picks, all at the one visibility primitive; then float
  // dated picks to the top soonest-first so a time-boxed event reads before the
  // standing options. A SEARCH read skips the calendar-season gate: its rows were
  // already season-targeted by the parent's chosen season, so a fall search viewed
  // in summer must still show (visibleSearchCandidates). The confidence order the DB
  // applied is preserved within each group (stable sort). The day-boundary/season
  // decisions use the family's own zone, not the server's.
  const timeZone = await readFamilyTimezone(database, familyId);
  const visible = opts?.searchSeason ? visibleSearchCandidates : visibleCandidates;
  const candidateRows = orderByDate(visible(currentRunRows, new Date(), timeZone));

  const routineRows = await database
    .select()
    .from(schema.routineProposals)
    .where(eq(schema.routineProposals.familyId, familyId))
    .orderBy(desc(schema.routineProposals.weekOf))
    .limit(1);

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
  const routine = routineRows[0] ? toRoutineProposalView(routineRows[0], teenChildIds) : null;

  return { candidates, routine };
}

/**
 * The credential-less-preview / unauthed boundary wrapper around readVillage: the
 * village page runs both in a preview (no DATABASE_URL, no session) and a real
 * authed session, landing both on the same calm empty state for the two EXPECTED
 * boundaries only. A genuine query failure once a DB exists must surface (rule #8).
 */
export function loadVillage(opts?: VillageReadOptions): Promise<VillageData> {
  return readForFamily((database, familyId) => readVillage(database, familyId, opts), EMPTY_VILLAGE);
}

/**
 * The family's privately-saved candidates for the More → Saved screen, behind the
 * same preview/unauthed boundary as loadVillage: no DATABASE_URL (preview) or no
 * resolved family → an empty list. A genuine query failure surfaces (rule #8).
 */
export function loadSavedVillageCandidates(): Promise<VillageCandidateView[]> {
  return readForFamily((database, familyId) => readSavedVillageCandidates(database, familyId), []);
}
