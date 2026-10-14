import { describe, expect, it } from 'vitest';
import type { LiveRegistrationReading } from '~/lib/registration/live-reading';
import {
  deidentifyOfficialQuery,
  isOfficialPageAsk,
  officialPageFallbackReply,
  officialPageReply,
  officialPageReturnLine,
} from './official-page';

const COLD_START_ASK = 'cold start ask (test fixture)';
const WATCH_OFFER_ASK = 'watch offer ask (test fixture)';

describe('live official registration answers', () => {
  it('recognizes registration questions without a city-specific matcher', () => {
    for (const words of [
      'New York swim registration dates?',
      'London camp registration?',
      'When does swim registration open near me?',
    ]) {
      expect(isOfficialPageAsk(words)).toBe(true);
    }
    for (const words of ['hi', 'Maya is 4', 'I wanna learn swimming', 'who is this exactly?']) {
      expect(isOfficialPageAsk(words)).toBe(false);
    }
  });
  it('preserves the pending intake ask without copying the cold-start lock', () => {
    expect(officialPageReturnLine(COLD_START_ASK)).toBe(OFFICIAL_PAGE_RETURN_ASK);
    expect(officialPageReturnLine(COLD_START_ASK)).not.toBe(COLD_START_ASK);
    expect(officialPageReturnLine(WATCH_OFFER_ASK)).toBe('Still want me watching?');
  });
  it('an unreadable source is not a claim that the date is unpublished', () => {
    const body = officialPageFallbackReply(COLD_START_ASK, 'https://example.org/swim');
    expect(body).toContain(NOT_POSTED_YET);
    expect(body).toContain('https://example.org/swim');
    expect(body).not.toMatch(/not posted|no dates|2026/i);
  });
  it('keeps a date-only London source date-only, with its URL', () => {
    const reading: LiveRegistrationReading = {
      status: 'verified',
      reader: 'ai',
      checkedAt: new Date(),
      timeZone: 'Europe/London',
      sourceUrl: 'https://example.org/swim',
      dates: [
        {
          kind: 'general_open',
          date: '2026-10-20',
          time: null,
          evidence: ['Registration opens October 20, 2026'],
        },
      ],
    };
    const body = officialPageReply(reading, COLD_START_ASK);
    expect(body).toContain('2026-10-20');
    expect(body).toContain('Europe/London');
    expect(body).toContain('opening time not published');
    expect(body).toContain(reading.sourceUrl);
    expect(body).not.toMatch(/midnight|noon|12:00|09:00/);
  });
  it('reports a verified page date with an eligibility caveat, not a failed-date claim', () => {
    const reading: LiveRegistrationReading = {
      status: 'verified',
      reader: 'ai',
      checkedAt: new Date(),
      timeZone: 'America/Toronto',
      sourceUrl: 'https://www.markham.ca/registration',
      dates: [
        {
          kind: 'unclassified_open',
          date: '2026-08-11',
          time: '06:30',
          evidence: ['Register starting Aug. 11 at 6:30 AM'],
        },
      ],
    };
    const body = officialPageReply(reading, COLD_START_ASK);
    expect(body).toContain('2026-08-11 at 06:30 America/Toronto');
    expect(body).toContain('eligibility');
    expect(body).toContain(reading.sourceUrl);
    expect(body).not.toMatch(/couldn't verify|you can register|open to everyone/i);
  });
});
describe('official-page · what may be searched', () => {
  it('removes accented household names but preserves the requested ISO date', () => {
    const query = deidentifyOfficialQuery('When does swim open for Chloé on 2026-10-20?', [
      { name: 'Chloé', ageMonths: 36, agePrecision: 'months' },
    ]);
    expect(query).not.toContain('Chloé');
    expect(query).toContain('2026-10-20');
  });
  it('strips household names and a postal so they never cross the border', () => {
    const query = deidentifyOfficialQuery('When does swim open for Maya in L3R 2T6?', [
      { name: 'Maya', ageMonths: 48, agePrecision: 'years' },
    ]);
    expect(query.toLowerCase()).not.toContain('maya');
    expect(query).not.toMatch(/L3R/i);
    expect(query.toLowerCase()).toContain('swim');
  });
});
