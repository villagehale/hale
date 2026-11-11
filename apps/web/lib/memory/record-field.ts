import { RECORD_FIELDS } from '@hale/worker/memory-context';

/**
 * Whether a remembered fact is the child's age or the family's home.
 *
 * The postal code and the date of birth are the record. A fact about either one said
 * before the record was last written is the old copy, so the shared prompt read
 * (`factsForContext`) leaves it out; one said after is the parent's correction, and it is
 * read in the record's place (`recordCorrections`). The signal is
 * `record`, set by the extractor when it saves the fact (`save_memory` /
 * `save_child_fact`). The key's spelling is not the signal: `ville`, `quartier` and
 * `lives_in` are a home only when extraction says so, and `home_city` is not a home
 * when it doesn't.
 */
export type RecordField = (typeof RECORD_FIELDS)[number];

/** Stamp the extractor's mark onto the stored value. A string value becomes an object
 * so the mark survives beside the text. */
export function withRecordField(value: unknown, record: RecordField | null | undefined): unknown {
  if (!record) return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return { ...(value as Record<string, unknown>), record };
  }
  return { text: value, record };
}

/** The mark on a stored value, or null when it has none. */
export function recordFieldOf(value: unknown): RecordField | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = (value as { record?: unknown }).record;
  return RECORD_FIELDS.find((field) => field === record) ?? null;
}
