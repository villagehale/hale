/**
 * Whether a remembered fact is the child's age or the family's home.
 *
 * The postal code and the date of birth are the record. A fact about either one
 * is the old copy, so find and the coach leave it out. The signal is `record`,
 * set by the extractor when it saves the fact (`save_memory` / `save_child_fact`).
 * The key's spelling is not the signal: `ville`, `quartier` and `lives_in` are
 * a home only when extraction says so, and `home_city` is not a home when it doesn't.
 */

export const RECORD_FIELDS = ['age', 'place'] as const;
export type RecordField = (typeof RECORD_FIELDS)[number];

export function recordFieldOf(value: unknown): RecordField | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = (value as { record?: unknown }).record;
  return record === 'age' || record === 'place' ? record : null;
}

/** True when extraction marked this fact as age or home. The key is ignored. */
export function shadowsRecord(value: unknown): boolean {
  return recordFieldOf(value) !== null;
}

/**
 * Leave this fact out of a find, the coach memory list, and the brief.
 *
 * A marked age or place is the old record, so it is out even when fresh.
 * A fact with no mark uses the same freshness window as every other fact
 * (`isFactFresh` / `FACT_FRESH_DAYS`): past that window it is dropped the
 * same way a stale age or place fact is. A fresh unmarked fact stays.
 * Parent-said facts stay for 365 days, so a 20-day unmarked `home_city` is
 * still inside the window.
 */
export function heldFromFamilyPrompt(value: unknown, fresh: boolean): boolean {
  if (shadowsRecord(value)) return true;
  return !fresh;
}

/** Stamp the extractor's mark onto the stored value. A string value becomes an object
 * so the mark survives beside the text. */
export function withRecordField(value: unknown, record: RecordField | null | undefined): unknown {
  if (record !== 'age' && record !== 'place') return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return { ...(value as Record<string, unknown>), record };
  }
  return { text: value, record };
}
