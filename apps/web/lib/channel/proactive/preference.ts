/**
 * VIL-226 · a cadence preference the decider inferred from one parent's own words.
 *
 * It is that parent's: kept on the decision's audit row with their user id, and read
 * back only for a batch made wholly of their items, so one parent's "text me less" never
 * sets the other's pace (rule #5). It is never a family memory fact, because the coach
 * reads every live fact into every parent's turn. Shadow keeps none: shadow changes
 * nothing a parent sees. Opting out is not this: consent is read from the ledger by the
 * outbound gate, and nothing here reads or writes it.
 */

export interface CadencePreference {
  schemaVersion: 1;
  parentUserId: string;
  direction: 'less' | 'more';
  note: string;
}

/** Why a preference the decider heard was not kept. Named on the decision's audit row. */
export type CadenceNotKept = 'not_written_shadow' | 'not_written_no_single_author';

export function cadencePreference(
  parentUserId: string,
  direction: 'less' | 'more',
  note: string,
): CadencePreference {
  return { schemaVersion: 1, parentUserId, direction, note };
}

export function readCadencePreference(value: unknown): CadencePreference | null {
  if (typeof value !== 'object' || value === null) return null;
  const row = value as {
    schemaVersion?: unknown;
    parentUserId?: unknown;
    direction?: unknown;
    note?: unknown;
  };
  if (row.schemaVersion !== 1) return null;
  if (typeof row.parentUserId !== 'string') return null;
  if (row.direction !== 'less' && row.direction !== 'more') return null;
  if (typeof row.note !== 'string') return null;
  return {
    schemaVersion: 1,
    parentUserId: row.parentUserId,
    direction: row.direction,
    note: row.note,
  };
}
