import { describe, expect, it } from 'vitest';
import { allAnswers } from '~/lib/answers/index.js';
import { SITE_URL } from '~/lib/app-url.js';
import { allCheckpoints } from '~/lib/milestones/index.js';
import sitemap from './sitemap.js';

/**
 * The sitemap is the index gate's enforcement point: only human-reviewed
 * (published) answer pages may appear. The reviewed set below rides in (behind
 * the /answers index); every other page stays a noindex draft and out of the
 * sitemap. Flipping a page's `published` flag is the single action that lets it in.
 */

const PUBLISHED_SLUGS = [
  'newborn-sleep-fragmented',
  'newborn-safe-sleep-basics',
  'toddler-tantrums-how-to-handle',
  'child-homework-battles',
  'child-sibling-fighting',
  'newborn-cluster-feeding',
  'introducing-peanuts-to-baby',
  'starting-solids-when-ready',
  'toddler-biting-what-to-do',
  'toddler-separation-anxiety-daycare',
  'potty-training-readiness-signs',
  'toddler-screen-time-guidelines',
  'child-managing-screen-time',
  'teen-mental-health-warning-signs',
  'teen-setting-boundaries-autonomy',
];

describe('sitemap', () => {
  const entries = sitemap();
  const urls = entries.map((e) => e.url);

  it('keeps the core marketing routes', () => {
    expect(urls).toContain(SITE_URL);
    expect(urls).toContain(`${SITE_URL}/about`);
    expect(urls).toContain(`${SITE_URL}/contact`);
    expect(urls).toContain(`${SITE_URL}/pricing`);
  });

  it('lists exactly the published answer slugs (and the /answers index)', () => {
    const answerUrls = urls
      .filter((u) => u.startsWith(`${SITE_URL}/answers`))
      .sort();
    const expected = [
      `${SITE_URL}/answers`,
      ...PUBLISHED_SLUGS.map((slug) => `${SITE_URL}/answers/${slug}`),
    ].sort();
    expect(answerUrls).toEqual(expected);
  });

  it('excludes every held (unpublished) answer page', () => {
    for (const page of allAnswers.filter((a) => !a.published)) {
      expect(urls).not.toContain(`${SITE_URL}/answers/${page.slug}`);
    }
  });

  it('gives each published answer page weekly/0.6 sitemap metadata', () => {
    for (const slug of PUBLISHED_SLUGS) {
      const entry = entries.find((e) => e.url === `${SITE_URL}/answers/${slug}`);
      expect(entry).toBeDefined();
      expect(entry?.changeFrequency).toBe('weekly');
      expect(entry?.priority).toBe(0.6);
    }
  });

  /**
   * The milestones hub and its twelve checkpoint pages were retired to a permanent
   * redirect (receipts-room slimdown). A retired route must never be advertised for
   * indexing — a sitemap entry that 308s is a crawl budget spent on a redirect, and it
   * keeps the old positioning alive in search results.
   *
   * The two positive controls run the SAME filter over the SAME `urls` list, so this
   * cannot pass vacuously: if the sitemap were empty (or the URL shape changed), the
   * /answers and /activities assertions below would fail first.
   */
  it('advertises no milestones URL — the route is retired', () => {
    expect(urls.filter((u) => u.startsWith(`${SITE_URL}/milestones`))).toEqual([]);
    // Positive controls through the identical prefix filter.
    expect(urls.filter((u) => u.startsWith(`${SITE_URL}/answers`)).length).toBeGreaterThan(0);
    expect(urls.filter((u) => u.startsWith(`${SITE_URL}/activities`)).length).toBeGreaterThan(0);
  });

  it('still carries no checkpoint slug anywhere in the sitemap', () => {
    for (const checkpoint of allCheckpoints) {
      expect(entries.find((e) => e.url.endsWith(`/${checkpoint.slug}`))).toBeUndefined();
    }
  });
});
