import { describe, expect, it } from 'vitest';
import { normalizeExtractedRegistration } from './live-reading';
import { registrationDate } from './read';
import type { ExtractedWindow, SeasonRegistrationWindow } from './verify-window';

/**
 * A printed date whose year the page does not establish: the reader keeps its quote as a
 * partial date and never turns it into a date field. Driven with hand-built extraction
 * answers (a parse-boundary input; model quality is the eval's job).
 */

const SOURCE = {
  sourceUrl: 'https://example.org/registration',
  checkedAt: new Date('2026-10-01T12:00:00Z'),
};

function extracted(overrides: Partial<ExtractedWindow>): ExtractedWindow {
  return {
    found: true,
    reason: null,
    cycleOnPage: null,
    yearEvidence: null,
    evidence: 'Registration opens December 7.',
    preview: null,
    residentOpen: null,
    generalOpen: null,
    unclassifiedOpen: null,
    partialDates: [{ kind: 'unclassified_open', quote: 'December 7' }],
    timeZone: null,
    timeZoneEvidence: null,
    note: 'The page prints no year for this date.',
    confidence: 0.9,
    ...overrides,
  };
}

describe('a partial date', () => {
  const PAGE = 'Registration opens December 7.';

  it('is incomplete_date, carrying the quoted partial and no date', () => {
    const reading = normalizeExtractedRegistration(extracted({}), PAGE, SOURCE);

    expect(reading).toEqual({
      ...SOURCE,
      reader: 'ai',
      status: 'unverified',
      reason: 'incomplete_date',
      partialDates: [{ kind: 'unclassified_open', quote: 'December 7' }],
    });
    expect(registrationDate(reading, false)).toBeNull();
    expect(registrationDate(reading, true)).toBeNull();
  });

  it('is refused when its quote is not on the page, and carries no partial (control)', () => {
    const reading = normalizeExtractedRegistration(
      extracted({ partialDates: [{ kind: 'unclassified_open', quote: 'December 8' }] }),
      PAGE,
      SOURCE,
    );
    expect(reading).toMatchObject({ status: 'unverified', reason: 'uncorroborated' });
    expect(reading).toHaveProperty('partialDates', []);
  });

  it('rides alongside a complete date without becoming one', () => {
    const page =
      'Preview December 1, 2026. Registration opens December 7. Pool hours are Eastern Time.';
    const reading = normalizeExtractedRegistration(
      extracted({
        evidence: 'Preview December 1, 2026. Registration opens December 7.',
        yearEvidence: 'December 1, 2026',
        preview: {
          quote: 'December 1, 2026',
          dateText: 'December 1, 2026',
          timeText: null,
          date: '2026-12-01',
          time: null,
        },
        timeZone: 'America/New_York',
        timeZoneEvidence: 'Eastern Time',
      }),
      page,
      SOURCE,
    );

    expect(reading).toMatchObject({
      status: 'verified',
      dates: [{ kind: 'preview', date: '2026-12-01', time: null }],
      partialDates: [{ kind: 'unclassified_open', quote: 'December 7' }],
    });
    if (reading.status !== 'verified') throw new Error('expected verified');
    expect(reading.dates).toHaveLength(1);
  });
});

describe('a yearless date pinned by the weekday the page prints (own-city lane only)', () => {
  const WINTER_2027: SeasonRegistrationWindow = { from: '2026-10-01', through: '2027-01-31' };
  // Toronto's register page, 2026-11-12: the district row prints no year.
  const ROW = 'Winter Recreation: North York and Scarborough Wednesday, December 9, 7 a.m.';
  const PAGE = `City of Toronto. ${ROW} Winter programs run January 4 to April 2, 2027.`;
  const NOW = new Date('2026-11-12T20:00:00Z');
  const source = { sourceUrl: 'https://www.toronto.ca/register/', checkedAt: NOW };
  const toronto = (quote: string, page = PAGE) =>
    normalizeExtractedRegistration(
      extracted({
        evidence: ROW,
        partialDates: [{ kind: 'unclassified_open', quote }],
        timeZone: 'America/Toronto',
        timeZoneEvidence: 'City of Toronto',
      }),
      page,
      source,
      WINTER_2027,
    );

  it('takes the one year whose calendar puts that weekday on that date', () => {
    expect(toronto('Wednesday, December 9, 7 a.m.')).toEqual({
      ...source,
      reader: 'ai',
      status: 'verified',
      timeZone: 'America/Toronto',
      dates: [
        {
          kind: 'unclassified_open',
          date: '2026-12-09',
          time: '07:00',
          evidence: ['Wednesday, December 9, 7 a.m.', ROW],
          yearFrom: 'printed_weekday',
        },
      ],
      partialDates: [],
    });
  });

  it('is never inferred for a reader that did not ask (the catalog lanes)', () => {
    const reading = normalizeExtractedRegistration(
      extracted({
        evidence: ROW,
        partialDates: [{ kind: 'unclassified_open', quote: 'Wednesday, December 9, 7 a.m.' }],
        timeZone: 'America/Toronto',
        timeZoneEvidence: 'City of Toronto',
      }),
      PAGE,
      source,
    );
    expect(reading).toMatchObject({ status: 'unverified', reason: 'incomplete_date' });
  });

  it('infers nothing when neither this year nor next fits the weekday', () => {
    const page = `${PAGE} Friday, December 9, 7 a.m.`;
    expect(toronto('Friday, December 9, 7 a.m.', page)).toMatchObject({
      status: 'unverified',
      reason: 'incomplete_date',
    });
  });

  it('infers nothing for a date already past, or outside the season being read', () => {
    const late = normalizeExtractedRegistration(
      extracted({
        evidence: ROW,
        partialDates: [{ kind: 'unclassified_open', quote: 'Wednesday, December 9, 7 a.m.' }],
        timeZone: 'America/Toronto',
        timeZoneEvidence: 'City of Toronto',
      }),
      PAGE,
      { ...source, checkedAt: new Date('2026-12-10T12:00:00Z') },
      WINTER_2027,
    );
    expect(late).toMatchObject({ status: 'unverified', reason: 'incomplete_date' });
    const offSeason = normalizeExtractedRegistration(
      extracted({
        evidence: ROW,
        partialDates: [{ kind: 'unclassified_open', quote: 'Wednesday, December 9, 7 a.m.' }],
        timeZone: 'America/Toronto',
        timeZoneEvidence: 'City of Toronto',
      }),
      PAGE,
      source,
      { from: '2028-10-01', through: '2029-01-31' },
    );
    expect(offSeason).toMatchObject({ status: 'unverified', reason: 'incomplete_date' });
  });

  it('infers nothing for a date that does not fall in the months this season registers in', () => {
    // Each fits exactly one of this year and next by its weekday, and each is ahead, but
    // none is a Winter 2027 registration date: next winter's, a spring and a summer date.
    const page = `${PAGE} Thursday, December 9, 7 a.m. Wednesday, June 9, 7 a.m. Wednesday, August 11.`;
    for (const quote of [
      'Thursday, December 9, 7 a.m.',
      'Wednesday, June 9, 7 a.m.',
      'Wednesday, August 11',
    ]) {
      expect({ quote, reading: toronto(quote, page) }).toMatchObject({
        quote,
        reading: { status: 'unverified', reason: 'incomplete_date' },
      });
    }
  });

  it('needs the weekday printed with the date, and one clock at most', () => {
    const page = `${PAGE} Registration opens December 9, 7 a.m. Doors at 7 a.m. or 9 a.m. Wednesday, December 9.`;
    expect(toronto('December 9, 7 a.m.', page)).toMatchObject({ reason: 'incomplete_date' });
    expect(toronto('7 a.m. or 9 a.m. Wednesday, December 9', page)).toMatchObject({
      reason: 'incomplete_date',
    });
  });
});

describe("the page's own name for the programs", () => {
  const ROW =
    'Winter Session 2027 &ndash; ten-week session Registration Date: December 16, 2026 at 8 a.m.';
  const PAGE = `The City of Greater Sudbury. Swimming lessons. ${ROW}`;
  const read = (cycleOnPage: string) =>
    normalizeExtractedRegistration(
      extracted({
        cycleOnPage,
        evidence: ROW,
        yearEvidence: 'Registration Date: December 16, 2026 at 8 a.m.',
        partialDates: [],
        unclassifiedOpen: {
          quote: 'December 16, 2026 at 8 a.m.',
          dateText: 'December 16, 2026',
          timeText: '8 a.m.',
          date: '2026-12-16',
          time: '08:00',
        },
        timeZone: 'America/Toronto',
        timeZoneEvidence: 'The City of Greater Sudbury',
      }),
      PAGE,
      SOURCE,
    );

  it('is carried when its words are on the page', () => {
    expect(read('Winter Session 2027 – ten-week session')).toMatchObject({
      status: 'verified',
      programOnPage: 'Winter Session 2027 – ten-week session',
    });
  });

  it('is left out when the page does not say it (control)', () => {
    const reading = read('Winter 2027 Recreation Programs');
    expect(reading.status).toBe('verified');
    expect(reading).not.toHaveProperty('programOnPage');
  });
});
