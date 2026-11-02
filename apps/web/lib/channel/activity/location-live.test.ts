import { expect, it, vi } from 'vitest';
import { activityClient } from '~/lib/pipeline/client';
import { stripHtml } from '~/lib/registration/fetch';
import * as sourcePage from '~/lib/registration/page';
import { createActivityFinder } from './lane';
import { qualifyActivityLocation } from './location';

const cases = [
  {
    city: 'Burlington',
    province: 'ON',
    library: 'Burlington Public Library',
    host: /(^|\.)bpl\.on\.ca$/,
  },
  { city: 'London', province: 'ON', library: 'London Public Library', host: /(^|\.)lpl\.ca$/ },
  { city: 'London', province: 'ON', library: 'Local library', host: /(^|\.)lpl\.ca$/ },
  {
    city: 'Cambridge',
    province: 'ON',
    library: 'Cambridge Public Library',
    host: /(^|\.)(?:ideaexchange\.org|cambridgelibraries\.ca)$/,
  },
  {
    city: 'Windsor',
    province: 'ON',
    library: 'Windsor Public Library',
    host: /(^|\.)windsorpubliclibrary\.com$/,
  },
  {
    city: 'Kingston',
    province: 'ON',
    library: 'Kingston Frontenac Public Library',
    host: /(^|\.)kfpl\.ca$/,
  },
  {
    city: 'Victoria',
    province: 'BC',
    library: 'Greater Victoria Public Library',
    host: /(^|\.)gvpl\.ca$|^gvpl\.libnet\.info$/,
  },
];

it.runIf(process.env.VIL423_LIVE_LOCATION_EVAL === 'true').each(cases)(
  'finds $city, $province, Canada ($library) through the production finder',
  async ({ city, province, library, host }) => {
    const fetchPage = sourcePage.createRegistrationPageFetch();
    const pages: { url: string; text: string }[] = [];
    const fetch = vi
      .spyOn(sourcePage, 'createRegistrationPageFetch')
      .mockReturnValue(async (url) => {
        const html = await fetchPage(url);
        pages.push({ url, text: stripHtml(html).slice(0, 20_000) });
        return html;
      });
    const start = Date.now();
    try {
      const query = {
        subject: `${library} storytime for preschoolers`,
        town: qualifyActivityLocation(city, province, 'Canada'),
        stage: 'preschool' as const,
        window: 'October 2026',
      };
      const result = await createActivityFinder(activityClient).find(query);
      console.info(
        JSON.stringify({
          kind: 'live-location-eval',
          query,
          elapsedMs: Date.now() - start,
          result,
          sources: pages.map(({ url, text }) => ({
            url,
            text,
          })),
        }),
      );
      expect(result.found).toBe(true);
      if (!result.found) return;
      expect(result.picks.length).toBeGreaterThan(0);
      for (const pick of result.picks) {
        expect(new URL(pick.sourceUrl ?? '').hostname).toMatch(host);
        const page = pages.find(({ url }) => url === pick.sourceUrl);
        expect(page?.text).toMatch(new RegExp(`\\b${city}\\b`, 'i'));
        expect(page?.text).toMatch(
          new RegExp(`\\b(?:${province}|${province === 'ON' ? 'Ontario' : 'British Columbia'})\\b`),
        );
      }
    } finally {
      fetch.mockRestore();
    }
  },
  240_000,
);
