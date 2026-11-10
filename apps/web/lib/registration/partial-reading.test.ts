import { describe, expect, it } from 'vitest';
import { normalizeExtractedRegistration } from './live-reading';
import { registrationDate } from './read';
import type { ExtractedWindow } from './verify-window';

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
