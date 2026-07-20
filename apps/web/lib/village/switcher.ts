import { db as defaultDb } from '~/lib/db';
import { currentFamilyId } from '~/lib/family';
import { listAreas, readActiveArea, type SavedArea, type SavedAreaLabel } from './areas';

/**
 * The top-bar location switcher's server data: the family's saved coarse areas + the
 * active one's human label (design handoff §3.2 / Interactions). COARSE only (rule
 * #1) — the same family-scoped reads the mobile /areas endpoint uses. Same empty
 * degradation as the other shell reads: no DB or no resolved family → empty, and
 * the switcher then renders nothing rather than a fabricated label.
 */
export interface AreaSwitcherData {
  areas: SavedArea[];
  activeLabel: SavedAreaLabel | null;
}

const EMPTY: AreaSwitcherData = { areas: [], activeLabel: null };

export async function loadAreaSwitcher(): Promise<AreaSwitcherData> {
  if (!process.env.DATABASE_URL) return EMPTY;
  const database = defaultDb();
  const familyId = await currentFamilyId(database);
  if (!familyId) return EMPTY;
  const [areas, activeLabel] = await Promise.all([
    listAreas(database, familyId),
    readActiveArea(database, familyId),
  ]);
  return { areas, activeLabel };
}
