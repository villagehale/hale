/**
 * VIL-226 · a cadence preference the decider inferred from plain words.
 * Stored as a memory fact (`preference` / `cadence`). STOP stays the carrier
 * keyword and is not this fact.
 */

export const CADENCE_FACT_KEY = 'cadence';

export interface CadenceFact {
  schemaVersion: 1;
  direction: 'less' | 'more';
  note: string;
}

export function cadenceFactValue(direction: 'less' | 'more', note: string): CadenceFact {
  return { schemaVersion: 1, direction, note };
}

export function readCadenceFact(value: unknown): CadenceFact | null {
  if (typeof value !== 'object' || value === null) return null;
  const row = value as { schemaVersion?: unknown; direction?: unknown; note?: unknown };
  if (row.schemaVersion !== 1) return null;
  if (row.direction !== 'less' && row.direction !== 'more') return null;
  if (typeof row.note !== 'string') return null;
  return { schemaVersion: 1, direction: row.direction, note: row.note };
}
