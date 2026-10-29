import { describe, expect, it } from 'vitest';
import { CHANGE_FRESH_MS, changeColumns, changeFromColumns, changeFromSource } from './change';

const TZ = 'America/Toronto';
const STORED = { startsAt: new Date('2026-10-26T19:00:00Z'), location: 'Georgetown library' };
const NOW = new Date('2026-10-26T12:00:00Z');

describe('VIL-474 · changeFromSource', () => {
  it('same day, new clock time: time', () => {
    expect(
      changeFromSource({
        stored: STORED,
        source: { startsAt: new Date('2026-10-26T20:30:00Z'), location: STORED.location },
        timeZone: TZ,
      }),
    ).toEqual({ field: 'time', previousStartsAt: STORED.startsAt });
  });
  it('another family-local day: date', () => {
    expect(
      changeFromSource({
        stored: STORED,
        source: { startsAt: new Date('2026-10-27T19:00:00Z'), location: null },
        timeZone: TZ,
      })?.field,
    ).toBe('date');
  });
  it('a different venue: venue, with the old venue', () => {
    expect(
      changeFromSource({
        stored: STORED,
        source: { startsAt: STORED.startsAt, location: 'Main St pool' },
        timeZone: TZ,
      }),
    ).toEqual({ field: 'venue', previousLocation: 'Georgetown library' });
  });
  it('nothing differs, or no source value: null', () => {
    expect(changeFromSource({ stored: STORED, source: { ...STORED }, timeZone: TZ })).toBeNull();
    expect(
      changeFromSource({
        stored: STORED,
        source: { startsAt: null, location: null },
        timeZone: TZ,
      }),
    ).toBeNull();
  });
});

describe('VIL-474 · the stored columns round-trip', () => {
  it('a change written is the change read back', () => {
    const time = { field: 'time' as const, previousStartsAt: STORED.startsAt };
    const venue = { field: 'venue' as const, previousLocation: 'Georgetown library' };
    expect(changeFromColumns(changeColumns(time, NOW), NOW)).toEqual(time);
    expect(changeFromColumns(changeColumns(venue, NOW), NOW)).toEqual(venue);
  });
  it('no columns, a stale change, or a malformed field: null', () => {
    const none = {
      sourceChangedField: null,
      sourceChangedFromStartsAt: null,
      sourceChangedFromLocation: null,
      sourceChangedAt: null,
    };
    expect(changeFromColumns(none, NOW)).toBeNull();
    const old = changeColumns(
      { field: 'venue', previousLocation: 'x' },
      new Date(NOW.getTime() - CHANGE_FRESH_MS - 1),
    );
    expect(changeFromColumns(old, NOW)).toBeNull();
    expect(
      changeFromColumns({ ...none, sourceChangedField: 'moved', sourceChangedAt: NOW }, NOW),
    ).toBeNull();
  });
});
