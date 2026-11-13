import { describe, expect, it } from 'vitest';
import {
  type LiveRegistrationDate,
  type VerifiedRegistrationReading,
  normalizeExtractedRegistration,
} from '../live-reading';
import type { ExtractedWindow } from '../verify-window';
import { familyOpening, openingInstant, openingPhrase } from './opening';
import type { OwnCity } from './place';

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
  evidence: string[] = [`${day} ${time}`],
): LiveRegistrationDate => ({ kind, date: day, time, evidence });

type Who = Pick<OwnCity, 'residencyKnown' | 'district'>;
const RESIDENT: Who = { residencyKnown: true, district: null };
const IN_DOUBT: Who = { residencyKnown: false, district: null };
const NORTH_YORK: Who = { residencyKnown: true, district: 'north_york' };

// Markham's page as published: residents Dec 1, non-residents Dec 2, both 6:30 AM.
const MARKHAM = reading([
  date('preview', '2026-11-16', null),
  date('resident_open', '2026-12-01'),
  date('general_open', '2026-12-02'),
]);

describe('familyOpening', () => {
  it("gives a resident the residents' morning and names the later one for everyone", () => {
    expect(familyOpening(MARKHAM, RESIDENT)).toEqual({
      own: MARKHAM.dates[1],
      general: MARKHAM.dates[2],
      residencyInDoubt: false,
    });
  });

  it('claims neither morning where residency is in doubt and residents open first: both, named', () => {
    expect(familyOpening(MARKHAM, IN_DOUBT)).toEqual({
      own: MARKHAM.dates[1],
      general: MARKHAM.dates[2],
      residencyInDoubt: true,
    });
  });

  it('gives a family in doubt one date when residents and everyone else open together', () => {
    const together = reading([
      date('resident_open', '2026-12-02'),
      date('general_open', '2026-12-02'),
    ]);
    const opening = { own: together.dates[1], general: null, residencyInDoubt: false };
    expect(familyOpening(together, IN_DOUBT)).toEqual(opening);
    // A resident is not told "everyone else" opens at the same moment, either.
    expect(familyOpening(together, RESIDENT)).toEqual({ ...opening, own: together.dates[0] });
  });

  it("names nothing for a family in doubt on a page with only a residents' morning", () => {
    const page = reading([
      date('resident_open', '2026-12-01'),
      date('unclassified_open', '2026-12-03'),
    ]);
    expect(familyOpening(page, IN_DOUBT)).toBeNull();
    expect(familyOpening(page, RESIDENT)).toEqual({
      own: page.dates[0],
      general: null,
      residencyInDoubt: false,
    });
  });

  it("takes an unlabelled opening on the family's own city's page as theirs", () => {
    const sudbury = reading([date('unclassified_open', '2026-12-16', '08:00')]);
    expect(familyOpening(sudbury, RESIDENT)).toEqual({
      own: sudbury.dates[0],
      general: null,
      residencyInDoubt: false,
    });
    // ...but not where residency is in doubt: it may be a residents-first morning.
    expect(familyOpening(sudbury, IN_DOUBT)).toBeNull();
  });

  it('has nothing for a page that printed only a preview', () => {
    expect(familyOpening(reading([date('preview', '2026-11-17', null)]), RESIDENT)).toBeNull();
  });

  it('prefers the opening for everyone over an unlabelled one', () => {
    const page = reading([
      date('unclassified_open', '2026-12-01', '07:00'),
      date('general_open', '2026-12-09', '07:00'),
    ]);
    expect(familyOpening(page, RESIDENT)).toEqual({
      own: page.dates[1],
      general: null,
      residencyInDoubt: false,
    });
  });
});

describe('familyOpening for a family whose district registers on its own morning', () => {
  const EARLY = date('resident_open', '2026-12-01', '07:00', [
    'Tuesday, December 1',
    'Early registration for winter activities and march break camp begins on Tuesday, December 1, at 7 a.m. for eligible residents of all ages.',
  ]);
  const NORTH_YORK_ROW = date('unclassified_open', '2026-12-09', '07:00', [
    'Wednesday, December 9, 7 a.m.',
    'Winter Recreation: North York and Scarborough Wednesday, December 9, 7 a.m.',
  ]);
  const FREE_CENTRES = date('unclassified_open', '2026-12-01', '07:00', [
    'Tuesday, December 1, 7 a.m.',
    'Registration for free centres begins Tuesday, December 1, 7 a.m.',
  ]);

  it("takes the district's own row, and never an early-local residents' morning", () => {
    const page = reading([EARLY, NORTH_YORK_ROW]);
    expect(familyOpening(page, NORTH_YORK)).toEqual({
      own: NORTH_YORK_ROW,
      general: null,
      residencyInDoubt: false,
    });
  });

  it('never takes an unlabelled date the page does not tie to the district', () => {
    expect(familyOpening(reading([FREE_CENTRES]), NORTH_YORK)).toBeNull();
    expect(familyOpening(reading([EARLY]), NORTH_YORK)).toBeNull();
  });

  it("takes a labelled opening for everyone only when it is the district's", () => {
    const general = { ...NORTH_YORK_ROW, kind: 'general_open' as const };
    expect(familyOpening(reading([general]), NORTH_YORK)).toEqual({
      own: general,
      general: null,
      residencyInDoubt: false,
    });
    expect(
      familyOpening(reading([general]), { residencyKnown: true, district: 'etobicoke_york' }),
    ).toBeNull();
  });
});

describe("a district family on the reader's real output: every date carries the section quote", () => {
  // Toronto's register page, 2026-11-12, in page order. The normalizer gives EVERY date the
  // model's one section quote, so a section quote naming North York must not qualify a
  // date that is not inside it.
  const FREE = 'Free Centres Tuesday, December 1, 7 a.m.';
  const OLDER = 'Older Adult Monday, December 7, 10 a.m.';
  const TEY = 'Winter Recreation: Toronto, East York and Etobicoke Tuesday, December 8, 7 a.m.';
  const NYS = 'Winter Recreation: North York and Scarborough Wednesday, December 9, 7 a.m.';
  const PAGE = `City of Toronto. ${FREE} ${OLDER} ${TEY} ${NYS}`;
  const read = (
    section: string,
    partials: Array<{ kind: LiveRegistrationDate['kind']; quote: string }>,
  ): VerifiedRegistrationReading => {
    const extracted: ExtractedWindow = {
      found: true,
      reason: null,
      cycleOnPage: null,
      yearEvidence: null,
      evidence: section,
      preview: null,
      residentOpen: null,
      generalOpen: null,
      unclassifiedOpen: null,
      partialDates: partials as ExtractedWindow['partialDates'],
      timeZone: 'America/Toronto',
      timeZoneEvidence: 'City of Toronto',
      note: null,
      confidence: 0.9,
    };
    const reading = normalizeExtractedRegistration(
      extracted,
      PAGE,
      { sourceUrl: 'https://www.toronto.ca/register/', checkedAt: NOW },
      { from: '2026-10-01', through: '2027-01-31' },
    );
    if (reading.status !== 'verified') throw new Error(`expected verified, got ${reading.status}`);
    return reading;
  };
  const opens = (reading: VerifiedRegistrationReading) => {
    const found = familyOpening(reading, NORTH_YORK);
    return found ? `${found.own.date} ${found.own.time}` : null;
  };
  const unlabelled = (quote: string) => ({ kind: 'unclassified_open' as const, quote });

  it("takes the district's own date even when another date comes first", () => {
    expect(
      opens(
        read(NYS, [
          unlabelled('Tuesday, December 1, 7 a.m.'),
          unlabelled('Wednesday, December 9, 7 a.m.'),
        ]),
      ),
    ).toBe('2026-12-09 07:00');
    expect(
      opens(
        read(NYS, [
          unlabelled('Monday, December 7, 10 a.m.'),
          unlabelled('Wednesday, December 9, 7 a.m.'),
        ]),
      ),
    ).toBe('2026-12-09 07:00');
  });

  it("takes no date the district's section does not hold", () => {
    expect(opens(read(NYS, [unlabelled('Tuesday, December 1, 7 a.m.')]))).toBeNull();
    expect(opens(read(NYS, [unlabelled('Tuesday, December 8, 7 a.m.')]))).toBeNull();
  });

  it('a section quote that spans more than one row ties no date to the district', () => {
    expect(opens(read(`${TEY} ${NYS}`, [unlabelled('Tuesday, December 8, 7 a.m.')]))).toBeNull();
    expect(opens(read(`${TEY} ${NYS}`, [unlabelled('Wednesday, December 9, 7 a.m.')]))).toBeNull();
  });

  it("never takes a residents' morning, even one inside the district's section", () => {
    expect(
      opens(read(NYS, [{ kind: 'resident_open', quote: 'Wednesday, December 9, 7 a.m.' }])),
    ).toBeNull();
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
