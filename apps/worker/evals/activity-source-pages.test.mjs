import { describe, expect, it, vi } from 'vitest';
import { EVAL_NOW, readSourcePages } from './run-activity-finder-eval.mjs';
import { ACTIVITY_FIXTURES as fixtures } from './activity-finder-fixtures.mjs';

describe('Finder eval official-page input (mechanics only)', () => {
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
      (html) => html.replace(/<[^>]*>/g, ''),
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
      (x) => x,
    );
    expect(result.pages).toEqual([]);
    expect(result.pagesRefused).toBe(2);
    expect(result.notes).toBe('');
  });
});
