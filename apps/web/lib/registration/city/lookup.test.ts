import { describe, expect, it } from 'vitest';
import type { LiveRegistrationReading } from '../live-reading';
import type { RegistrationReader, RegistrationTarget } from '../read';
import { type CityLookupDeps, lookupCityRegistration, readCycleLabel } from './lookup';
import type { OfficialSite } from './official-site';
import type { OwnCity } from './place';
import type { PageSearch } from './search';

/**
 * The lookup's own decisions: which page's reading wins, and which "no" a city gets. The
 * reader is a scripted port here; what it reads off a real page is the reader's tests
 * and the registration evals (hard rule #8).
 */

const NOW = new Date('2026-11-12T15:00:00Z');
const NORTH_YORK: OwnCity = {
  city: 'Toronto',
  provinceOrState: 'Ontario',
  country: 'Canada',
  district: 'north_york',
  residencyKnown: true,
};
const A = 'https://www.toronto.ca/explore-enjoy/parks-recreation/register/';
const B = 'https://www.toronto.ca/news/winter-registration/';

const source = (url: string) => ({ sourceUrl: url, checkedAt: NOW, reader: 'ai' as const });

const verified = (url: string, kinds: Array<'preview' | 'unclassified_open'>) =>
  ({
    ...source(url),
    status: 'verified',
    timeZone: 'America/Toronto',
    dates: kinds.map((kind) => ({
      kind,
      date: kind === 'preview' ? '2026-11-17' : '2026-12-09',
      time: kind === 'preview' ? null : '07:00',
      evidence: [
        'Wednesday, December 9, 7 a.m.',
        'Winter Recreation: North York and Scarborough Wednesday, December 9, 7 a.m.',
      ],
    })),
    partialDates: [],
  }) satisfies LiveRegistrationReading;

const TORONTO_SITE: OfficialSite = {
  status: 'found',
  host: 'toronto.ca',
  website: 'https://www.toronto.ca/',
  source: 'wikidata:Q172',
};

function deps(
  search: PageSearch,
  readings: Record<string, LiveRegistrationReading>,
  asked: RegistrationTarget[] = [],
  site: OfficialSite = TORONTO_SITE,
  searched: string[] = [],
): CityLookupDeps {
  const read: RegistrationReader = async (target) => {
    asked.push(target);
    const reading = readings[target.sourceUrl];
    if (!reading) throw new Error(`no scripted reading for ${target.sourceUrl}`);
    return reading;
  };
  return {
    officialSite: async () => site,
    search: async (place) => {
      searched.push(place.city);
      return search;
    },
    read,
  };
}

const pages = (urls: string[]): PageSearch => ({
  outcome: 'pages',
  municipality: 'City of Toronto',
  urls,
});

describe('lookupCityRegistration', () => {
  it("asks the reader for the family's own district morning, on the city's own page", async () => {
    const asked: RegistrationTarget[] = [];
    const found = await lookupCityRegistration(
      deps(pages([A]), { [A]: verified(A, ['unclassified_open']) }, asked),
      NORTH_YORK,
      'Winter 2027',
      NOW,
    );
    expect(found).toMatchObject({
      status: 'verified',
      municipality: 'City of Toronto',
      sourceUrl: A,
    });
    expect(asked).toEqual([
      {
        municipality: 'City of Toronto',
        programDomain: 'rec_program',
        cycleLabel: 'Winter 2027 (north york)',
        sourceUrl: A,
      },
    ]);
  });

  it('takes the first page that verifies an opening; a preview alone is not one', async () => {
    const found = await lookupCityRegistration(
      deps(pages([A, B]), {
        [A]: verified(A, ['preview']),
        [B]: verified(B, ['preview', 'unclassified_open']),
      }),
      NORTH_YORK,
      'Winter 2027',
      NOW,
    );
    expect(found.status === 'verified' && found.sourceUrl).toBe(B);
  });

  it('says not published when a page answered that the season is not out', async () => {
    const found = await lookupCityRegistration(
      deps(pages([A, B]), {
        [A]: { ...source(A), status: 'unverified', reason: 'announced_later', partialDates: [] },
        [B]: { ...source(B), status: 'unreadable', reason: 'http_status' },
      }),
      NORTH_YORK,
      'Winter 2027',
      NOW,
    );
    expect(found).toEqual({
      status: 'not_found',
      reason: 'not_published',
      municipality: 'City of Toronto',
      tried: [
        { url: A, outcome: 'unverified:announced_later' },
        { url: B, outcome: 'unreadable:http_status' },
      ],
    });
  });

  it('names a page that prints the opening without its year, never a guessed year', async () => {
    const found = await lookupCityRegistration(
      deps(pages([A, B]), {
        [A]: {
          ...source(A),
          status: 'unverified',
          reason: 'incomplete_date',
          partialDates: [{ kind: 'unclassified_open', quote: 'Wednesday, December 9, 7 a.m.' }],
        },
        [B]: { ...source(B), status: 'unverified', reason: 'announced_later', partialDates: [] },
      }),
      NORTH_YORK,
      'Winter 2027',
      NOW,
    );
    expect(found).toMatchObject({ status: 'not_found', reason: 'date_without_year' });
  });

  it('says unreadable when no page could be read or verified, never "not published"', async () => {
    const found = await lookupCityRegistration(
      deps(pages([A]), {
        [A]: { ...source(A), status: 'unverified', reason: 'uncorroborated', partialDates: [] },
      }),
      NORTH_YORK,
      'Winter 2027',
      NOW,
    );
    expect(found).toMatchObject({ status: 'not_found', reason: 'unreadable' });
  });

  it('asks again later when the search or the reader did not finish', async () => {
    const failed = await lookupCityRegistration(
      deps({ outcome: 'failed', reason: 'search_failed:APIError' }, {}),
      NORTH_YORK,
      'Winter 2027',
      NOW,
    );
    expect(failed).toEqual({ status: 'retry', reason: 'search_failed:APIError' });

    const busy = await lookupCityRegistration(
      deps(pages([A]), { [A]: { ...source(A), status: 'busy', reason: 'host_busy' } }),
      NORTH_YORK,
      'Winter 2027',
      NOW,
    );
    expect(busy).toEqual({ status: 'retry', reason: 'reader_busy' });
  });

  it('names a city with no official page, and reads nothing', async () => {
    const asked: RegistrationTarget[] = [];
    const found = await lookupCityRegistration(
      deps({ outcome: 'none', reason: 'not_this_place' }, {}, asked),
      NORTH_YORK,
      'Winter 2027',
      NOW,
    );
    expect(found).toEqual({
      status: 'not_found',
      reason: 'no_official_page',
      municipality: null,
      tried: [],
    });
    expect(asked).toEqual([]);
  });
});

describe("a page with no opening for this family's district", () => {
  it('is read past, so the page that names the district wins', async () => {
    const early = {
      ...verified(A, ['unclassified_open']),
      dates: [
        {
          kind: 'resident_open' as const,
          date: '2026-12-01',
          time: '07:00',
          evidence: [
            'Early registration begins Tuesday, December 1, at 7 a.m. for eligible residents',
          ],
        },
      ],
    };
    const district = {
      ...verified(B, ['unclassified_open']),
      dates: [
        {
          kind: 'unclassified_open' as const,
          date: '2026-12-09',
          time: '07:00',
          evidence: ['Winter Recreation: North York and Scarborough Wednesday, December 9, 7 a.m.'],
        },
      ],
    };
    const found = await lookupCityRegistration(
      deps(pages([A, B]), { [A]: early, [B]: district }),
      NORTH_YORK,
      'Winter 2027',
      NOW,
    );
    expect(found).toMatchObject({ status: 'verified', sourceUrl: B });
  });
});

describe('a page read that did not finish', () => {
  it('a timeout, network error, server error or failed extraction is asked again, never "not found"', async () => {
    for (const reason of [
      'timeout',
      'network_error',
      'http_server_error',
      'extract_failed',
    ] as const) {
      const found = await lookupCityRegistration(
        deps(pages([A, B]), {
          [A]: { ...source(A), status: 'unreadable', reason },
          [B]: { ...source(B), status: 'unverified', reason: 'announced_later', partialDates: [] },
        }),
        NORTH_YORK,
        'Winter 2027',
        NOW,
      );
      expect({ reason, found }).toEqual({
        reason,
        found: { status: 'retry', reason: `page_unread:${reason}` },
      });
    }
  });

  it('a page that refuses for good (a 4xx) is still a named "not found"', async () => {
    const found = await lookupCityRegistration(
      deps(pages([A]), { [A]: { ...source(A), status: 'unreadable', reason: 'http_status' } }),
      NORTH_YORK,
      'Winter 2027',
      NOW,
    );
    expect(found).toMatchObject({ status: 'not_found', reason: 'unreadable' });
  });
});

describe("the city's official site", () => {
  const NEWS =
    'https://nowtoronto.com/news/torontonians-can-now-register-for-winter-recreation-and-march-break-programs-including-swimming-skating-and-camps/';
  const COUNCILLOR = 'https://www.councillorpaulafletcher.ca/fall-and-winter-recreation-programs';
  const AGGREGATOR = 'https://sporting.ca/toronto/registration-dates';
  const MAYOR =
    'https://www.mayoroliviachow.ca/city_of_toronto_announces_early_registration_for_older_adult_winter_programs_opens_tomorrow';

  it('reads only the pages on it, and names the ones it refused', async () => {
    const asked: RegistrationTarget[] = [];
    const found = await lookupCityRegistration(
      deps(pages([NEWS, AGGREGATOR, A]), { [A]: verified(A, ['unclassified_open']) }, asked),
      NORTH_YORK,
      'Winter 2027',
      NOW,
    );
    expect(found).toMatchObject({ status: 'verified', sourceUrl: A });
    expect(asked.map((target) => target.sourceUrl)).toEqual([A]);
  });

  it('a search that named only pages off the site is "no official page", and nothing is read', async () => {
    const asked: RegistrationTarget[] = [];
    const found = await lookupCityRegistration(
      deps(pages([NEWS, COUNCILLOR, AGGREGATOR, MAYOR]), {}, asked),
      NORTH_YORK,
      'Winter 2027',
      NOW,
    );
    expect(found).toEqual({
      status: 'not_found',
      reason: 'no_official_page',
      municipality: 'City of Toronto',
      tried: [NEWS, COUNCILLOR, AGGREGATOR, MAYOR].map((url) => ({
        url,
        outcome: 'not_official_site',
      })),
    });
    expect(asked).toEqual([]);
  });

  it('a city whose official site cannot be established is not searched', async () => {
    const searched: string[] = [];
    const found = await lookupCityRegistration(
      deps(pages([A]), {}, [], { status: 'not_found', reason: 'ambiguous' }, searched),
      NORTH_YORK,
      'Winter 2027',
      NOW,
    );
    expect(found).toEqual({
      status: 'not_found',
      reason: 'no_official_site',
      municipality: null,
      tried: [],
    });
    expect(searched).toEqual([]);
  });

  it('a source that did not answer is asked again', async () => {
    const found = await lookupCityRegistration(
      deps(pages([A]), {}, [], { status: 'retry', reason: 'source_failed:TypeError' }),
      NORTH_YORK,
      'Winter 2027',
      NOW,
    );
    expect(found).toEqual({ status: 'retry', reason: 'official_site:source_failed:TypeError' });
  });
});

describe('readCycleLabel', () => {
  it('names a Toronto district, and nothing elsewhere', () => {
    expect(readCycleLabel({ district: 'toronto_east_york' }, 'Winter 2027')).toBe(
      'Winter 2027 (toronto east york)',
    );
    expect(readCycleLabel({ district: null }, 'Winter 2027')).toBe('Winter 2027');
  });
});
