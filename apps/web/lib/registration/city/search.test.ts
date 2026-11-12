import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import type { OwnCity } from './place';
import {
  MAX_CANDIDATE_PAGES,
  namesThisPlace,
  pageSearchOutcome,
  pageSearchUserMessage,
  readPageSearchAnswer,
} from './search';

/**
 * The search turn's reading, with no model in it: which pages may be read, and when a
 * turn named none. The skill's own judgement is the city-registration eval's job (hard
 * rule #8); these are the code rails around what it returns.
 */

const SUDBURY: OwnCity = {
  city: 'Greater Sudbury',
  provinceOrState: 'Ontario',
  country: 'Canada',
  district: null,
  residencyKnown: true,
};
const PAGE =
  'https://www.greatersudbury.ca/play/pools/swimming-lessons/program-registration-dates/';
const NEWS = 'https://www.greatersudbury.ca/city-hall/news-and-public-notices/';

function results(urls: readonly string[]): Anthropic.ContentBlock {
  return {
    type: 'web_search_tool_result',
    tool_use_id: 'srvtoolu_1',
    content: urls.map((url) => ({
      type: 'web_search_result',
      url,
      title: 'result',
      encrypted_content: 'x',
      page_age: null,
    })),
  } as unknown as Anthropic.ContentBlock;
}

function text(body: string): Anthropic.ContentBlock {
  return { type: 'text', text: body, citations: null } as Anthropic.ContentBlock;
}

const answer = (value: unknown) => text(`Here is what I found.\n${JSON.stringify(value)}`);

describe('the page search outcome', () => {
  it('reads the pages the search returned, for the municipality that is this place', () => {
    const outcome = pageSearchOutcome(
      [
        results([PAGE, NEWS]),
        answer({ municipality: 'City of Greater Sudbury', pages: [PAGE, NEWS], note: null }),
      ],
      SUDBURY,
    );
    expect(outcome).toEqual({
      outcome: 'pages',
      municipality: 'City of Greater Sudbury',
      urls: [PAGE, NEWS],
    });
  });

  it('never reads a page no search result carried, a plain-http page, or one twice', () => {
    const invented = 'https://www.greatersudbury.ca/winter-2027-dates/';
    const outcome = pageSearchOutcome(
      [
        results([PAGE, 'http://www.greatersudbury.ca/old/']),
        answer({
          municipality: 'Greater Sudbury',
          pages: [invented, 'http://www.greatersudbury.ca/old/', PAGE, PAGE],
          note: null,
        }),
      ],
      SUDBURY,
    );
    expect(outcome).toEqual({ outcome: 'pages', municipality: 'Greater Sudbury', urls: [PAGE] });
  });

  it('reads at most the bound, best first', () => {
    const urls = ['a', 'b', 'c', 'd', 'e'].map((slug) => `https://www.greatersudbury.ca/${slug}`);
    const outcome = pageSearchOutcome(
      [results(urls), answer({ municipality: 'Greater Sudbury', pages: urls, note: null })],
      SUDBURY,
    );
    expect(outcome.outcome === 'pages' && outcome.urls).toEqual(urls.slice(0, MAX_CANDIDATE_PAGES));
  });

  it("refuses a neighbouring town's page for this place", () => {
    const outcome = pageSearchOutcome(
      [results([PAGE]), answer({ municipality: 'City of North Bay', pages: [PAGE], note: null })],
      SUDBURY,
    );
    expect(outcome).toEqual({ outcome: 'none', reason: 'not_this_place' });
  });

  it('names each way a finished turn has nothing to read', () => {
    expect(pageSearchOutcome([answer({ municipality: null, pages: [] })], SUDBURY)).toEqual({
      outcome: 'none',
      reason: 'no_results',
    });
    expect(
      pageSearchOutcome(
        [results([PAGE]), answer({ municipality: null, pages: [], note: 'split' })],
        SUDBURY,
      ),
    ).toEqual({ outcome: 'none', reason: 'no_official_page' });
    expect(
      pageSearchOutcome(
        [results([PAGE]), answer({ municipality: 'Greater Sudbury', pages: [NEWS] })],
        SUDBURY,
      ),
    ).toEqual({ outcome: 'none', reason: 'no_official_page' });
    expect(pageSearchOutcome([results([PAGE]), text('I could not decide.')], SUDBURY)).toEqual({
      outcome: 'none',
      reason: 'unparsed',
    });
  });

  it('takes the answer from after the last search, not a note written mid-search', () => {
    const early = answer({ municipality: 'Greater Sudbury', pages: [PAGE], note: null });
    expect(readPageSearchAnswer([early, results([PAGE])])).toBeNull();
    expect(readPageSearchAnswer([results([PAGE]), early])).toEqual({
      municipality: 'Greater Sudbury',
      pages: [PAGE],
      note: null,
    });
  });
});

describe('namesThisPlace', () => {
  it('matches the city as whole words inside the municipality name', () => {
    expect(namesThisPlace('City of Toronto', 'Toronto')).toBe(true);
    expect(namesThisPlace('Ville de Montréal', 'Montreal')).toBe(true);
    expect(namesThisPlace('Town of Whitchurch-Stouffville', 'Whitchurch-Stouffville')).toBe(true);
    expect(namesThisPlace('City of Greater Sudbury', 'Sudbury')).toBe(true);
  });

  it('does not match another town, or a name that only shares letters', () => {
    expect(namesThisPlace('City of Vaughan', 'Markham')).toBe(false);
    expect(namesThisPlace('Town of Ajax', 'Ajaxville')).toBe(false);
    expect(namesThisPlace('City of Kingston', 'King')).toBe(false);
  });
});

describe('the search request', () => {
  it('carries a public place and a season, and nothing about a family', () => {
    expect(JSON.parse(pageSearchUserMessage(SUDBURY, 'Winter 2027', '2026-11-12'))).toEqual({
      city: 'Greater Sudbury',
      province_or_state: 'Ontario',
      country: 'Canada',
      season: 'Winter 2027',
      today: '2026-11-12',
    });
  });
});
