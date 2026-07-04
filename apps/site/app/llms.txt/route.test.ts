import { describe, expect, it } from 'vitest';
import { allAnswers, publishedAnswers } from '~/lib/answers/index.js';
import { SITE_URL } from '~/lib/app-url.js';
import { GET } from './route.js';

/**
 * llms.txt is the AI-assistant-facing index: it must list every published answer
 * page and never a held draft — the same review-before-index gate the sitemap
 * enforces. If a held page leaked in here, an assistant could surface unreviewed
 * YMYL health copy. These assertions lock the gate and the self-describing header.
 */

async function body(): Promise<string> {
  return await GET().text();
}

describe('llms.txt', () => {
  it('is served as plain text', () => {
    const res = GET();
    expect(res.headers.get('content-type')).toContain('text/plain');
  });

  it('lists every published answer page by its canonical URL', async () => {
    const text = await body();
    for (const page of publishedAnswers) {
      expect(text).toContain(`${SITE_URL}/answers/${page.slug}`);
    }
  });

  it('lists exactly the published answers — no held drafts leak in', async () => {
    const text = await body();
    const listedSlugs = [...text.matchAll(/\/answers\/([a-z0-9-]+)\)/g)].map((m) => m[1]);
    expect(new Set(listedSlugs)).toEqual(new Set(publishedAnswers.map((p) => p.slug)));

    for (const page of allAnswers.filter((a) => !a.published)) {
      expect(text).not.toContain(`/answers/${page.slug})`);
    }
  });

  it('describes what Hale is and that the content is cited, not medical advice', async () => {
    const text = await body();
    expect(text).toMatch(/^# Hale/);
    expect(text.toLowerCase()).toContain('privacy-first family ai');
    expect(text.toLowerCase()).toContain('0–18');
    expect(text.toLowerCase()).toContain('not medical advice');
  });
});
