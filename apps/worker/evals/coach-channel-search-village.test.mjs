import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import { beforeAll, describe, expect, it } from 'vitest';
import { gatedSearchVillageHandler, searchedWindow } from './coach-channel-search-village.mjs';

/**
 * The coach-channel eval's `search_village` runs the PRODUCTION de-identifier and place
 * gate, so the window the day judge reads is the one that would reach the search. It once
 * recorded the model's raw window, and a day the gate scrubbed ("today Sunday [redacted]")
 * was graded as if the search had seen it.
 */

const DEIDENTIFY_SRC = fileURLToPath(
  new URL('../../web/lib/channel/activity/deidentify.ts', import.meta.url),
);
const NAMED_AREA_SRC = fileURLToPath(
  new URL('../../web/lib/channel/named-area.ts', import.meta.url),
);
const WEB_TSCONFIG = fileURLToPath(new URL('../../web/tsconfig.json', import.meta.url));

let deidentify;
let namedArea;
beforeAll(async () => {
  const options = { parentURL: import.meta.url, tsconfig: WEB_TSCONFIG };
  deidentify = await tsImport(DEIDENTIFY_SRC, options);
  namedArea = await tsImport(NAMED_AREA_SRC, options);
}, 60_000);

const FAMILY = {
  town: 'Toronto',
  stage: 'preschool',
  householdNames: ['Milo', 'Sam'],
  today: '2026-08-09 (Sunday)',
};
const DAY_FINDS = { candidates: [{ title: 'Family skate', url: 'https://example.org/skate' }] };
const YEAR_FINDS = { candidates: [{ title: 'Tumble tots' }] };

async function search(input) {
  const calls = [];
  const handler = gatedSearchVillageHandler({
    deidentify,
    namedArea,
    family: FAMILY,
    record: (tool, extra) => calls.push({ tool, ...extra }),
    village: DAY_FINDS,
    yearVillage: YEAR_FINDS,
    toolOutputs: [],
    linkRef: (url) => `ref:${url}`,
  });
  return { shown: await handler(input), calls };
}

describe('the eval search_village runs the production de-identifier', () => {
  it('records what crossed: the day as `date`, every date in the window text scrubbed', async () => {
    const { calls, shown } = await search({
      query: 'things to do',
      window: 'Saturday 2026-08-15, not 2024-03-15',
      date: '2026-08-15',
    });
    expect(calls).toEqual([
      {
        tool: 'search_village',
        window: 'Saturday [redacted], not [redacted]',
        date: '2026-08-15 (Saturday)',
      },
    ]);
    expect(searchedWindow(calls[0])).toBe(
      'Saturday [redacted], not [redacted] · 2026-08-15 (Saturday)',
    );
    expect(shown.candidates).toEqual([
      { title: 'Family skate', ref: 'ref:https://example.org/skate' },
    ]);
  });

  it('a `date` alone is a search for that day', async () => {
    const { calls, shown } = await search({ query: 'things to do', date: '2026-08-09' });
    expect(calls).toEqual([{ tool: 'search_village', window: null, date: '2026-08-09 (Sunday)' }]);
    expect(searchedWindow(calls[0])).toBe('2026-08-09 (Sunday)');
    expect(shown.candidates).toEqual([
      { title: 'Family skate', ref: 'ref:https://example.org/skate' },
    ]);
  });

  it('a `date` two years out does not cross, so the search is for the whole year', async () => {
    const { calls, shown } = await search({ query: 'things to do', date: '2028-08-09' });
    expect(calls).toEqual([{ tool: 'search_village', window: null, date: null }]);
    expect(searchedWindow(calls[0])).toBeNull();
    expect(shown.candidates).toEqual([{ title: 'Tumble tots' }]);
  });

  it('answers a name in the query as production does: nothing searched, the refusal named', async () => {
    const { calls, shown } = await search({ query: 'gymnastics for Milo', window: 'Saturday' });
    expect(shown).toEqual({
      candidates: [],
      inVerification: 0,
      standingOption: null,
      liveRead: 'names_a_person',
    });
    expect(calls).toEqual([
      { tool: 'search_village', window: null, date: null, refusal: 'names_a_person' },
    ]);
  });

  it('answers an `area` that is not a place as production does: nothing searched', async () => {
    const { calls, shown } = await search({ date: '2026-08-09', area: 'today' });
    expect(shown).toEqual({
      candidates: [],
      inVerification: 0,
      standingOption: null,
      liveRead: 'area_unusable',
    });
    expect(calls).toEqual([
      { tool: 'search_village', window: null, date: null, refusal: 'area_unusable' },
    ]);
  });

  it('POSITIVE CONTROL - the family town as `area` still searches', async () => {
    const { calls, shown } = await search({ date: '2026-08-09', area: 'toronto' });
    expect(calls).toEqual([{ tool: 'search_village', window: null, date: '2026-08-09 (Sunday)' }]);
    expect(shown.candidates).toEqual([
      { title: 'Family skate', ref: 'ref:https://example.org/skate' },
    ]);
  });

  it('POSITIVE CONTROL - no window searches the whole year', async () => {
    const { calls, shown } = await search({ query: 'things to do' });
    expect(calls).toEqual([{ tool: 'search_village', window: null, date: null }]);
    expect(shown.candidates).toEqual([{ title: 'Tumble tots' }]);
  });
});
