import { describe, expect, it } from 'vitest';
import { type VillageMatchRow, filterVillageRows } from './query-match';

/**
 * "Saturday kids activities" is not a substring of "Central Library story time".
 * The old literal match returned nothing. These pin the token match and the
 * fallback that replaced it.
 */

const STORY: VillageMatchRow = {
  title: 'Central Library story time',
  summary: 'Free indoor drop-in, all ages welcome.',
  eventDate: '2026-08-08',
};

const SUNDAY: VillageMatchRow = {
  title: 'Riverdale Farm visit',
  summary: 'Free outdoor farm, open daily.',
  eventDate: '2026-08-09',
};

const SWIM: VillageMatchRow = {
  title: 'Parent and tot swim',
  summary: 'Indoor lane at the community centre.',
  eventDate: '2026-08-08',
};

const UNVERIFIED: VillageMatchRow = {
  title: 'Unplaced find',
  summary: 'Place and day not checked yet.',
  eventDate: null,
};

describe('filterVillageRows', () => {
  it('matches any remaining token, not the whole query as one substring', () => {
    const rows = [STORY, SWIM, SUNDAY];

    expect(filterVillageRows(rows, 'swim').map((row) => row.title)).toEqual([SWIM.title]);
    expect(filterVillageRows(rows, 'library farm').map((row) => row.title)).toEqual([
      STORY.title,
      SUNDAY.title,
    ]);
    // The phrase is not in either Saturday title. Both Saturday rows still come back.
    expect(filterVillageRows(rows, 'Saturday kids activities').map((row) => row.title)).toEqual([
      STORY.title,
      SWIM.title,
    ]);
  });

  it('keeps the Saturday story time when the query is only a day and generic words', () => {
    const kept = filterVillageRows([STORY, SUNDAY, UNVERIFIED], 'Saturday kids activities');

    expect(kept.map((row) => row.title)).toEqual([STORY.title, UNVERIFIED.title]);
  });

  it('falls back to the date window when no content token hits', () => {
    const kept = filterVillageRows([STORY, SUNDAY], 'pottery');

    expect(kept.map((row) => row.title)).toEqual([STORY.title, SUNDAY.title]);
  });

  it('falls back inside the asked day, using the date rather than the title', () => {
    const kept = filterVillageRows([STORY, SUNDAY, UNVERIFIED], 'pottery Saturday');

    expect(kept.map((row) => row.title)).toEqual([STORY.title, UNVERIFIED.title]);
    expect(STORY.title.toLowerCase().includes('saturday')).toBe(false);
  });

  it('drops a dated find that falls on a different day', () => {
    const wednesday: VillageMatchRow = {
      title: 'Maybe class',
      summary: 'Not placed yet.',
      eventDate: '2026-08-05',
    };

    const kept = filterVillageRows([STORY, wednesday, UNVERIFIED], 'Saturday');

    expect(kept.map((row) => row.title)).toEqual([STORY.title, UNVERIFIED.title]);
  });
});
