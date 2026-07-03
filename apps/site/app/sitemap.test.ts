import { describe, expect, it } from 'vitest';
import { allAnswers } from '~/lib/answers/index.js';
import { SITE_URL } from '~/lib/app-url.js';
import sitemap from './sitemap.js';

/**
 * The sitemap is the index gate's enforcement point: only human-reviewed
 * (published) answer pages may appear. Because the shipped corpus is entirely
 * unpublished drafts, no /answers/* URL may be present yet — flipping a page's
 * `published` flag is the single action that lets it in.
 */

describe('sitemap', () => {
  const entries = sitemap();
  const urls = entries.map((e) => e.url);

  it('keeps the core marketing routes', () => {
    expect(urls).toContain(SITE_URL);
    expect(urls).toContain(`${SITE_URL}/about`);
    expect(urls).toContain(`${SITE_URL}/contact`);
  });

  it('excludes every unpublished answer page', () => {
    for (const page of allAnswers) {
      expect(urls).not.toContain(`${SITE_URL}/answers/${page.slug}`);
    }
  });

  it('would list an answer page only once it is published', () => {
    const published = allAnswers.filter((a) => a.published);
    for (const page of published) {
      const entry = entries.find((e) => e.url === `${SITE_URL}/answers/${page.slug}`);
      expect(entry).toBeDefined();
      expect(entry?.changeFrequency).toBe('weekly');
      expect(entry?.priority).toBe(0.6);
    }
  });
});
