import type { Database } from '@hale/db';
import { createBiblioCommonsAdapter } from '~/lib/civic/bibliocommons';
import { createEarlyOnTorontoAdapter } from '~/lib/civic/earlyon-toronto';
import { LIBRARY_SYSTEM_LIST } from '~/lib/civic/library-systems';
import { type ParsedHours, parseCivicHours } from '~/lib/civic/parse-hours';
import { type CivicSystemSummary, runCivicSweep } from '~/lib/civic/sweep';
import { type CivicAdapter, type FetchJson, createFetchJson } from '~/lib/civic/types';
import { pipelineClient } from '~/lib/pipeline/client';
import { type LatLng, geocodeArea } from '~/lib/village/geocode';

/**
 * VIL-252 · M16 — the weekly civic refresh.
 *
 * Two phases, and they are separate on purpose:
 *
 *   INGEST  — refresh the family-agnostic registry once for everybody. This is
 *             where the network and any model calls happen, and its cost does not
 *             scale with how many families Hale has.
 *   PROJECT — per family, replace their civic candidates from the refreshed
 *             facts. Pure database work: no network, no model.
 *
 * A family whose projection fails does not stop the others, and an ingest failure
 * in one library system does not stop the rest (see runCivicSweep).
 */

export interface CivicSweepRunResult {
  systems: CivicSystemSummary[];
  familiesProjected: number;
  candidatesWritten: number;
  errors: Array<{ familyId: string; error: string }>;
}

export interface CivicSweepDeps {
  fetchJson: FetchJson;
  parseHours(text: string): Promise<ParsedHours>;
  /** The COARSE area's centroid (rule #1 — an FSA's middle, never a home), used
   * to keep a family's picks within reach of them. Null on a miss; the projection
   * then degrades to the municipality gate rather than failing. */
  resolveCenter(areaCoarse: string): Promise<LatLng | null>;
}

export function defaultCivicSweepDeps(): CivicSweepDeps {
  const client = pipelineClient();
  return {
    fetchJson: createFetchJson(),
    parseHours: (text: string) => parseCivicHours(text, { client }),
    resolveCenter: (areaCoarse: string) => geocodeArea(areaCoarse),
  };
}

/** Every source this layer reads. Adding a library system is a row in
 * LIBRARY_SYSTEMS, not a change here. */
export function civicAdapters(deps: CivicSweepDeps): CivicAdapter[] {
  return [
    ...LIBRARY_SYSTEM_LIST.map(createBiblioCommonsAdapter),
    createEarlyOnTorontoAdapter({ parseHours: deps.parseHours }),
  ];
}

export async function runCivicSweepCron(
  database: Database,
  deps: CivicSweepDeps = defaultCivicSweepDeps(),
  now: Date = new Date(),
): Promise<CivicSweepRunResult> {
  const systems = await runCivicSweep(database, civicAdapters(deps), deps.fetchJson, now);

  return { systems, familiesProjected: 0, candidatesWritten: 0, errors: [] };
}
