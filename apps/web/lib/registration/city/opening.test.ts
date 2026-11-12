import { describe, expect, it } from 'vitest';
import type { LiveRegistrationDate, VerifiedRegistrationReading } from '../live-reading';
import { familyOpening, openingInstant, openingPhrase } from './opening';

const NOW = new Date('2026-11-12T15:00:00Z');

function reading(dates: LiveRegistrationDate[]): VerifiedRegistrationReading {
  return {
    sourceUrl: 'https://www.markham.ca/registration',
    checkedAt: NOW,
    reader: 'ai',
    status: 'verified',
    timeZone: 'America/Toronto',
    dates,
    partialDates: [],
  };
}

const date = (
  kind: LiveRegistrationDate['kind'],
  day: string,
  time: string | null = '06:30',
): LiveRegistrationDate => ({ kind, date: day, time, evidence: [`${day} ${time}`] });

// Markham's page as published: residents Dec 1, non-residents Dec 2, both 6:30 AM.
const MARKHAM = reading([
  date('preview', '2026-11-16', null),
  date('resident_open', '2026-12-01'),
  date('general_open', '2026-12-02'),
]);

describe('familyOpening', () => {
  it("gives a resident the residents' morning and names the later one for everyone", () => {
    expect(familyOpening(MARKHAM, true)).toEqual({
      own: MARKHAM.dates[1],
      general: MARKHAM.dates[2],
    });
  });

  it('claims only the opening for everyone where residency is in doubt', () => {
    expect(familyOpening(MARKHAM, false)).toEqual({ own: MARKHAM.dates[2], general: null });
  });

  it("takes an unlabelled opening on the family's own city's page as theirs", () => {
    const toronto = reading([date('unclassified_open', '2026-12-09', '07:00')]);
    expect(familyOpening(toronto, true)).toEqual({ own: toronto.dates[0], general: null });
    // ...but not where residency is in doubt: it may be a residents-first morning.
    expect(familyOpening(toronto, false)).toBeNull();
  });

  it('has nothing for a page that printed only a preview', () => {
    expect(familyOpening(reading([date('preview', '2026-11-17', null)]), true)).toBeNull();
  });
});

describe('openingPhrase', () => {
  it("states the page's own clock, in the page's zone", () => {
    const resident = MARKHAM.dates[1] as LiveRegistrationDate;
    expect(openingInstant(MARKHAM, resident).toISOString()).toBe('2026-12-01T11:30:00.000Z');
    expect(openingPhrase(MARKHAM, resident, NOW)).toBe('Dec 1, 6:30 a.m.');
  });

  it('states no time the page did not print', () => {
    const dateOnly = reading([date('general_open', '2026-12-16', null)]);
    expect(openingPhrase(dateOnly, dateOnly.dates[0] as LiveRegistrationDate, NOW)).toBe('Dec 16');
  });
});
