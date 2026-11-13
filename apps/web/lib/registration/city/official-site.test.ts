import { describe, expect, it } from 'vitest';
import {
  type NamedPlace,
  type OfficialSite,
  type OfficialSiteSource,
  lookupOfficialSite,
  officialSiteOf,
  onOfficialSite,
  placeCheckQuery,
} from './official-site';
import type { OwnCity } from './place';

/**
 * Which host is a city's own, read off a structured public source's answer, and which
 * page URLs are on it. The fake source below answers in the shape Wikidata's action API
 * returns (wbsearchentities, wbgetentities), with entities as recorded 2026-11-12.
 */

const TORONTO: OwnCity = {
  city: 'Toronto',
  provinceOrState: 'Ontario',
  country: 'Canada',
  district: 'north_york',
  residencyKnown: true,
};

const TORONTO_SITE: OfficialSite = {
  status: 'found',
  host: 'toronto.ca',
  website: 'https://www.toronto.ca/',
  source: 'wikidata:Q172',
  referenced: false,
};

const place = (
  qid: string,
  website: string,
  how: 'label' | 'alias',
  referenced = false,
): NamedPlace => ({ qid, website, how, referenced });

describe('officialSiteOf', () => {
  it("names the municipality's own host, without its www", () => {
    expect(officialSiteOf([place('Q172', 'https://www.toronto.ca/', 'label')])).toEqual(
      TORONTO_SITE,
    );
  });

  it('prefers the place whose name IS the city over one that only has it as an alias', () => {
    const found = officialSiteOf([
      place('Q18419', 'https://www.brooklynbp.nyc.gov/', 'label'),
      place('Q371625', 'https://www.brooklyn.edu/', 'alias'),
    ]);
    expect(found).toMatchObject({ status: 'found', host: 'brooklynbp.nyc.gov' });
  });

  it('establishes nothing when two places with the name have different sites', () => {
    expect(
      officialSiteOf([
        place('Q133116', 'https://www.hamilton.ca/', 'label'),
        place('Q5644773', 'http://www.hamiltontownship.ca', 'label'),
      ]),
    ).toEqual({ status: 'not_found', reason: 'ambiguous' });
  });

  it('one place listed twice (http and https) is still one site', () => {
    expect(
      officialSiteOf([
        place('Q172', 'http://www.toronto.ca', 'label'),
        place('Q172', 'https://www.toronto.ca/', 'label'),
      ]),
    ).toMatchObject({ status: 'found', host: 'toronto.ca', website: 'https://www.toronto.ca/' });
  });

  it('names a place the source does not know', () => {
    expect(officialSiteOf([])).toEqual({ status: 'not_found', reason: 'no_entry' });
  });

  it('never establishes shared hosting or a public suffix as a city site', () => {
    for (const website of [
      'https://smalltown.github.io/',
      'https://smalltown.blogspot.com/',
      'https://smalltown.wixsite.com/home',
      'https://smalltown.squarespace.com/',
      'https://on.ca/',
    ]) {
      expect({ website, site: officialSiteOf([place('Q1', website, 'label', true)]) }).toEqual({
        website,
        site: { status: 'not_found', reason: 'shared_host' },
      });
    }
  });

  it("carries whether the source's statement of the site has a reference", () => {
    expect(officialSiteOf([place('Q44016', 'https://www.markham.ca/', 'label', true)])).toEqual({
      status: 'found',
      host: 'markham.ca',
      website: 'https://www.markham.ca/',
      source: 'wikidata:Q44016',
      referenced: true,
    });
  });
});

describe('onOfficialSite', () => {
  it('refuses news, aggregator, councillor and mayor pages for Toronto (the recorded search)', () => {
    for (const url of [
      'https://nowtoronto.com/news/torontonians-can-now-register-for-winter-recreation-and-march-break-programs-including-swimming-skating-and-camps/',
      'https://sporting.ca/toronto/registration-dates',
      'https://www.councillorpaulafletcher.ca/fall-and-winter-recreation-programs',
      'https://www.mayoroliviachow.ca/city_of_toronto_announces_early_registration_for_older_adult_winter_programs_opens_tomorrow',
      'https://www.vaughan.ca/residential/recreation-programs-and-fitness/recreation-programs',
      'https://nottoronto.ca/register',
      'https://toronto.ca.example.com/register',
      'http://www.toronto.ca/register',
    ]) {
      expect({ url, on: onOfficialSite(url, TORONTO_SITE) }).toEqual({ url, on: false });
    }
  });

  it("keeps the city's own pages, on its host or under it", () => {
    for (const url of [
      'https://www.toronto.ca/explore-enjoy/parks-recreation/program-activities/register-for-recreation-activities/',
      'https://toronto.ca/register',
      'https://secure.toronto.ca/register',
    ]) {
      expect({ url, on: onOfficialSite(url, TORONTO_SITE) }).toEqual({ url, on: true });
    }
  });

  it('holds a site that lives under a path to that path', () => {
    const site: OfficialSite = {
      status: 'found',
      host: 'sites.example.org',
      website: 'https://sites.example.org/view/smalltown/',
      source: 'wikidata:Q1',
      referenced: true,
    };
    expect(onOfficialSite('https://sites.example.org/view/smalltown/rec', site)).toBe(true);
    expect(onOfficialSite('https://sites.example.org/view/othertown/rec', site)).toBe(false);
    expect(onOfficialSite('https://other.sites.example.org/view/smalltown/rec', site)).toBe(false);
  });
});

interface FakeEntity {
  label: string;
  website?: string;
  referenced?: boolean;
  country?: string;
  parent?: string;
}

/**
 * Wikidata as it answered on 2026-11-12, for a few entities: the name search returns
 * `hits`; the SPARQL endpoint evaluates the place check over `entities` (website, country
 * label, and a province or state label up the "located in" chain).
 */
function wikidata(
  hits: Array<{ id: string; label: string; match?: { type: string; text: string } }>,
  entities: Record<string, FakeEntity>,
  asked: string[] = [],
): OfficialSiteSource {
  const labelUp = (id: string | undefined, want: string, hops = 6): boolean => {
    if (id === undefined || hops === 0) return false;
    const entity = entities[id];
    return entity?.label === want || labelUp(entity?.parent, want, hops - 1);
  };
  return {
    search: async (name) => {
      asked.push(`search:${name}`);
      return { search: hits };
    },
    sparql: async (query) => {
      asked.push('sparql');
      const ids = [...query.matchAll(/wd:(Q\d+)/g)].map((m) => m[1] as string);
      const literals = [...query.matchAll(/"([^"]*)"@en/g)].map((m) => m[1] as string);
      const [country, region] = literals;
      const bindings = ids.flatMap((id) => {
        const e = entities[id];
        if (!e?.website || entities[e.country ?? '']?.label !== country) return [];
        if (region !== undefined && !labelUp(e.parent, region)) return [];
        return [
          {
            item: { value: `http://www.wikidata.org/entity/${id}` },
            site: { value: e.website },
            referenced: { value: String(e.referenced === true) },
          },
        ];
      });
      return { results: { bindings } };
    },
  };
}

const CANADA = { Q16: { label: 'Canada' }, Q1904: { label: 'Ontario', country: 'Q16' } };

describe('lookupOfficialSite', () => {
  it('reads the site of the place named exactly the city, in its country and province', async () => {
    const asked: string[] = [];
    const found = await lookupOfficialSite(
      wikidata(
        [
          { id: 'Q172', label: 'Toronto' },
          { id: 'Q1', label: 'Toronto Maple Leafs' },
        ],
        {
          ...CANADA,
          Q172: {
            label: 'Toronto',
            website: 'https://www.toronto.ca/',
            country: 'Q16',
            parent: 'Q1904',
          },
        },
        asked,
      ),
      TORONTO,
    );
    expect(found).toEqual(TORONTO_SITE);
    // Only a public place name crosses to the source, in one search and one check.
    expect(asked).toEqual(['search:Toronto', 'sparql']);
  });

  it('walks up the "located in" chain to the province (a town inside a region)', async () => {
    const found = await lookupOfficialSite(
      wikidata([{ id: 'Q44016', label: 'Markham' }], {
        ...CANADA,
        Q2: { label: 'Regional Municipality of York', parent: 'Q1904' },
        Q44016: {
          label: 'Markham',
          website: 'https://www.markham.ca/',
          referenced: true,
          country: 'Q16',
          parent: 'Q2',
        },
      }),
      { ...TORONTO, city: 'Markham' },
    );
    expect(found).toMatchObject({
      status: 'found',
      host: 'markham.ca',
      source: 'wikidata:Q44016',
      referenced: true,
    });
  });

  it('reads a double-barrelled name whichever dash the source spells it with', async () => {
    const found = await lookupOfficialSite(
      wikidata([{ id: 'Q483334', label: 'Whitchurch–Stouffville' }], {
        ...CANADA,
        Q483334: {
          label: 'Whitchurch–Stouffville',
          website: 'http://www.Whitchurch-Stouffville.ca/',
          country: 'Q16',
          parent: 'Q1904',
        },
      }),
      { ...TORONTO, city: 'Whitchurch-Stouffville' },
    );
    expect(found).toMatchObject({ status: 'found', host: 'whitchurch-stouffville.ca' });
  });

  it('never takes a same-named place in another province or country', async () => {
    const found = await lookupOfficialSite(
      wikidata([{ id: 'Q9', label: 'Toronto' }], {
        ...CANADA,
        Q30: { label: 'United States' },
        Q1400: { label: 'Ohio', country: 'Q30' },
        Q9: {
          label: 'Toronto',
          website: 'https://toronto-oh.example/',
          country: 'Q30',
          parent: 'Q1400',
        },
      }),
      TORONTO,
    );
    expect(found).toEqual({ status: 'not_found', reason: 'no_entry' });
  });

  it('names an invented town as unknown', async () => {
    expect(
      await lookupOfficialSite(wikidata([], {}), { ...TORONTO, city: 'Fernwick Hollow' }),
    ).toEqual({ status: 'not_found', reason: 'no_entry' });
  });

  it('a source that fails is a retry, never "no site"', async () => {
    const found = await lookupOfficialSite(
      {
        search: async () => {
          throw new TypeError('fetch failed');
        },
        sparql: async () => ({}),
      },
      TORONTO,
    );
    expect(found).toEqual({ status: 'retry', reason: 'source_failed:TypeError' });
    const odd = { search: async () => ({ error: 'x' }), sparql: async () => ({}) };
    expect(await lookupOfficialSite(odd, TORONTO)).toEqual({
      status: 'retry',
      reason: 'source_unparsed',
    });
  });
});

describe('placeCheckQuery', () => {
  it('quotes the place names so a name cannot change the query, and keeps only ids', () => {
    const query = placeCheckQuery(['Q172', 'Q1 } #'], {
      provinceOrState: 'On"tario } #',
      country: 'Canada',
    });
    expect(query).toContain('VALUES ?item { wd:Q172 }');
    expect(query).toContain('"On\\"tario } #"@en');
    expect(query).toContain('"Canada"@en');
    // Whether the statement of each website carries a reference, read in the same query.
    expect(query).toContain('prov:wasDerivedFrom');
  });
});
