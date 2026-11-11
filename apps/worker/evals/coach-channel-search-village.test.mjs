import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import { beforeAll, describe, expect, it } from 'vitest';
import { gatedSearchVillageHandler } from './coach-channel-search-village.mjs';

/**
 * The coach-channel eval's `search_village` runs the PRODUCTION de-identifier, so the
 * window the day judge reads is the one that would reach the search. It once recorded the
 * model's raw window, and a day the gate scrubbed ("today Sunday [redacted]") was graded
 * as if the search had seen it.
 */

const DEIDENTIFY_SRC = fileURLToPath(
  new URL('../../web/lib/channel/activity/deidentify.ts', import.meta.url),
);
const WEB_TSCONFIG = fileURLToPath(new URL('../../web/tsconfig.json', import.meta.url));

let deidentify;
beforeAll(async () => {
  deidentify = await tsImport(DEIDENTIFY_SRC, {
    parentURL: import.meta.url,
    tsconfig: WEB_TSCONFIG,
  });
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
  it('records the window that crossed: the day kept, a date before today scrubbed', async () => {
    const { calls, shown } = await search({
      query: 'things to do',
      window: 'Saturday 2026-08-15, not 2024-03-15',
    });
    expect(calls).toEqual([
      { tool: 'search_village', window: 'Saturday 2026-08-15, not [redacted]' },
    ]);
    expect(shown.candidates).toEqual([
      { title: 'Family skate', ref: 'ref:https://example.org/skate' },
    ]);
  });

  it('answers a name in the query as production does: nothing searched, the refusal named', async () => {
    const { calls, shown } = await search({ query: 'gymnastics for Milo', window: 'Saturday' });
    expect(shown).toEqual({
      candidates: [],
      inVerification: 0,
      standingOption: null,
      liveRead: 'names_a_person',
    });
    expect(calls).toEqual([{ tool: 'search_village', window: null, refusal: 'names_a_person' }]);
  });

  it('POSITIVE CONTROL - no window searches the whole year', async () => {
    const { calls, shown } = await search({ query: 'things to do' });
    expect(calls).toEqual([{ tool: 'search_village', window: null }]);
    expect(shown.candidates).toEqual([{ title: 'Tumble tots' }]);
  });
});
