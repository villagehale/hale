import { describe, expect, it } from 'vitest';
import { registrationSeasonOf } from './registration-season.js';

const TORONTO = 'America/Toronto';

function at(iso: string): Date {
  return new Date(iso);
}

describe('registrationSeasonOf', () => {
  it('keys winter by the January year of the programs, spanning Oct–Jan', () => {
    expect(registrationSeasonOf(at('2026-10-01T04:00:00.000Z'), TORONTO)).toEqual({
      key: '2027-winter',
      season: 'winter',
      resetsOn: '2027-02-01',
    });
    expect(registrationSeasonOf(at('2026-12-15T17:00:00.000Z'), TORONTO)).toEqual({
      key: '2027-winter',
      season: 'winter',
      resetsOn: '2027-02-01',
    });
    expect(registrationSeasonOf(at('2027-01-31T16:00:00.000Z'), TORONTO)).toEqual({
      key: '2027-winter',
      season: 'winter',
      resetsOn: '2027-02-01',
    });
  });

  it('resets at the season boundary in the family timezone, not UTC', () => {
    // 2026-10-01 00:00 America/Toronto is 2026-10-01 04:00Z (EDT).
    expect(registrationSeasonOf(at('2026-10-01T03:59:59.000Z'), TORONTO).key).toBe('2026-fall');
    expect(registrationSeasonOf(at('2026-10-01T04:00:00.000Z'), TORONTO).key).toBe('2027-winter');
    // 2027-02-01 00:00 America/Toronto is 2027-02-01 05:00Z (EST).
    expect(registrationSeasonOf(at('2027-02-01T04:59:59.000Z'), TORONTO).key).toBe('2027-winter');
    expect(registrationSeasonOf(at('2027-02-01T05:00:00.000Z'), TORONTO).key).toBe('2027-spring');
  });

  it('names spring, summer and fall on their city-rec windows', () => {
    expect(registrationSeasonOf(at('2027-02-15T17:00:00.000Z'), TORONTO)).toEqual({
      key: '2027-spring',
      season: 'spring',
      resetsOn: '2027-04-01',
    });
    expect(registrationSeasonOf(at('2027-04-01T04:00:00.000Z'), TORONTO)).toEqual({
      key: '2027-summer',
      season: 'summer',
      resetsOn: '2027-07-01',
    });
    expect(registrationSeasonOf(at('2027-07-15T16:00:00.000Z'), TORONTO)).toEqual({
      key: '2027-fall',
      season: 'fall',
      resetsOn: '2027-10-01',
    });
  });

  it('falls back to UTC when the zone is not a real IANA name', () => {
    expect(registrationSeasonOf(at('2026-10-01T00:00:00.000Z'), 'not/a-zone').key).toBe(
      '2027-winter',
    );
  });
});
