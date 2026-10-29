/**
 * VIL-474 · a change the parent might have to act on, recorded ONLY from source data.
 *
 * `changeFromSource` compares what Hale had stored for an event with what a provider
 * now says (a provider email or calendar sync carrying a different start or venue).
 * It never reads wording: a title or a body that says "moved" or "rescheduled" is not
 * a source value and records nothing. No source value, no change.
 */

export type ChangedField = 'time' | 'date' | 'venue';

/** The raw change as the source gave it: which field and what it was before. */
export type SourceChange =
  | {
      field: 'time' | 'date';
      previousStartsAt: Date;
      /** Set when the venue changed in the same provider move: both are kept. */
      previousLocation?: string;
    }
  | { field: 'venue'; previousLocation: string };

function localDay(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone,
  }).format(instant);
}

/**
 * The change between `stored` and `source`, or null. A start that moved to another
 * family-local day is `date`; same day, different clock time is `time`. A start change
 * leads (the parent cannot be at the right place at the wrong time), and a venue that
 * changed in the same move rides along as `previousLocation` instead of being dropped.
 * A venue only counts when both sides name one and they differ.
 */
export function changeFromSource(args: {
  stored: { startsAt: Date; location: string | null };
  source: { startsAt: Date | null; location: string | null };
  timeZone: string;
}): SourceChange | null {
  const { stored, source, timeZone } = args;
  const before = stored.location?.trim() || null;
  const after = source.location?.trim() || null;
  const venueMoved = before !== null && after !== null && before !== after;
  if (source.startsAt && source.startsAt.getTime() !== stored.startsAt.getTime()) {
    const field =
      localDay(source.startsAt, timeZone) === localDay(stored.startsAt, timeZone) ? 'time' : 'date';
    return venueMoved
      ? { field, previousStartsAt: stored.startsAt, previousLocation: before }
      : { field, previousStartsAt: stored.startsAt };
  }
  if (venueMoved) return { field: 'venue', previousLocation: before };
  return null;
}

/** How long a recorded change stays news for a reminder. */
export const CHANGE_FRESH_MS = 7 * 24 * 3600_000;

/** The stored columns back as a change, or null when absent, stale or malformed. */
export function changeFromColumns(
  row: {
    sourceChangedField: string | null;
    sourceChangedFromStartsAt: Date | null;
    sourceChangedFromLocation: string | null;
    sourceChangedAt: Date | null;
  },
  now: Date,
): SourceChange | null {
  if (!row.sourceChangedAt || now.getTime() - row.sourceChangedAt.getTime() > CHANGE_FRESH_MS) {
    return null;
  }
  if (
    (row.sourceChangedField === 'time' || row.sourceChangedField === 'date') &&
    row.sourceChangedFromStartsAt
  ) {
    return row.sourceChangedFromLocation
      ? {
          field: row.sourceChangedField,
          previousStartsAt: row.sourceChangedFromStartsAt,
          previousLocation: row.sourceChangedFromLocation,
        }
      : { field: row.sourceChangedField, previousStartsAt: row.sourceChangedFromStartsAt };
  }
  if (row.sourceChangedField === 'venue' && row.sourceChangedFromLocation) {
    return { field: 'venue', previousLocation: row.sourceChangedFromLocation };
  }
  return null;
}

/** The columns a change writes. */
export function changeColumns(change: SourceChange, now: Date) {
  return {
    sourceChangedField: change.field,
    sourceChangedFromStartsAt: change.field === 'venue' ? null : change.previousStartsAt,
    sourceChangedFromLocation: change.previousLocation ?? null,
    sourceChangedAt: now,
  };
}
