import { tsImport } from 'tsx/esm/api';
import { describe, expect, it, vi } from 'vitest';
import { ACTIVITY_FIXTURES as fixtures } from './activity-finder-fixtures.mjs';
import { EVAL_NOW, normalizePicks, readSourcePages } from './run-activity-finder-eval.mjs';

const burlington = JSON.parse(
  readFileSync(
    new URL(
      '../../web/lib/channel/activity/__fixtures__/burlington-occurrences-2026-11-02.json',
      import.meta.url,
    ),
    'utf8',
  ),
);

const { createActivityPageFetch } = await tsImport('../../web/lib/channel/activity/page.ts', {
  parentURL: import.meta.url,
  tsconfig: new URL('../../web/tsconfig.json', import.meta.url).pathname,
});

describe('Finder eval official-page input (mechanics only)', () => {
  it('uses the same occurrence ownership check and preserves the verified URL in normalized picks', async () => {
    const [old, current] = burlington.pages;
    const ground = await readSourcePages(
      { evidence: old.url },
      createActivityPageFetch(
        async (url) => burlington.pages.find((page) => page.url === url).html,
      ),
      'Burlington, Ontario, Canada',
    );
    const raw = {
      name: 'Family Storytime',
      name_evidence: 'Family Storytime',
      source_name: 'Burlington Public Library',
      age_fit: 'Ages 5 and under.',
      age_evidence: 'Ages 5 and under.',
      sessions: [
        {
          date: '2026-10-30',
          start_time: '10:30',
          end_time: '11:00',
          evidence: 'Friday, October 30',
        },
      ],
    };
    const result = normalizePicks(
      [
        { ...raw, source_url: old.url },
        { ...raw, source_url: current.url },
      ],
      ground,
      { window: 'October 2026' },
    );
    expect(result.kept).toHaveLength(1);
    expect(result.kept[0]).toMatchObject({
      sourceUrl: current.url,
      when: '2026-10-30 10:30-11:00',
    });
    expect(result.references[0]).toMatchObject({
      sourceUrl: old.url,
      when: null,
      evidence: { sessions: [] },
    });
    expect(ground.notes).toContain('PAGE EVENT:');
    expect(ground.pages[0].occurrence.startDate).toBe('2026-10-23T10:30');
  });
  it('uses the production reader to exclude challenges while retaining a normal source', async () => {
    const fetch = createActivityPageFetch(async (url) =>
      url.startsWith('https://a.example')
        ? '<title>Verify you are human</title><p>Enable JavaScript.</p>'
        : '<p>Montréal (Québec) H2S 0C4. Storytime.</p>',
    );
    const result = await readSourcePages(
      { evidence: 'https://a.example\nhttps://b.example' },
      fetch,
      'Montréal, Quebec, Canada',
    );
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0].url).toBe('https://b.example/');
    expect(result.pagesRefused).toBe(1);
    expect(result.notes).not.toContain('https://a.example');
    expect(result.notes).not.toContain('Verify you are human');
  });

  it('does not forbid its own public search fields while still checking private identifiers', () => {
    for (const fixture of fixtures) {
      const publicQuery = [fixture.subject, fixture.town, fixture.stage, fixture.window]
        .join(' ')
        .toLowerCase();
      for (const forbidden of fixture.dropsFromQuery) {
        expect(publicQuery, `${fixture.id}: ${forbidden}`).not.toContain(forbidden.toLowerCase());
      }
    }
    const ny = fixtures.find((item) => item.id === 'travel-visit-new-york');
    expect(ny.dropsFromQuery).toEqual(expect.arrayContaining(['mia', '4 year']));
  });

  it('keeps positive travel windows after the declared corpus clock', () => {
    for (const fixture of fixtures.filter((item) => item.expectPicks && item.dateRange)) {
      expect(fixture.dateRange.start > EVAL_NOW.toISOString().slice(0, 10)).toBe(true);
    }
    const ny = fixtures.find((item) => item.id === 'travel-visit-new-york');
    expect(ny.window).toBe('November 12 to 15, 2026');
    expect(ny.rawSubject).toContain(ny.dateRange.start);
    expect(ny.rawSubject).toContain(ny.dateRange.end);
  });
  it('reads three unique discovered sources and never substitutes model notes for page text', async () => {
    const fetch = vi.fn(async (url) => ({
      url: `${url}/current`,
      text: '<p>Published program facts</p>',
    }));
    const result = await readSourcePages(
      {
        pages: [{ url: 'https://a.example' }],
        evidence: 'https://a.example\nhttps://b.example\nhttps://c.example\nhttps://d.example',
        notes: 'Invented by research prose',
      },
      fetch,
    );
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(result.pages).toHaveLength(3);
    expect(result.pagesRead).toBe(3);
    expect(result.notes).toContain('SOURCE: https://a.example/current\nPublished program facts');
    expect(result.notes).not.toContain('Invented');
  });
  it('keeps failed and blank page reads out of evidence without a prose fallback', async () => {
    const result = await readSourcePages(
      {
        pages: [],
        evidence: 'https://a.example\nhttps://b.example',
        notes: 'Plausible but unverified',
      },
      async (url) => {
        if (url === 'https://a.example') throw Error('refused');
        return { url, text: '   ' };
      },
    );
    expect(result.pages).toEqual([]);
    expect(result.pagesRefused).toBe(2);
    expect(result.notes).toBe('');
  });
});
import { readFileSync } from 'node:fs';
