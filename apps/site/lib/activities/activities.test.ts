import { describe, expect, it } from 'vitest';
import { allCities, getCity, publishedCities, universalIdeas } from './index';
import { cityJsonLd, hubJsonLd } from './structured-data';

describe('activities data', () => {
  it('has cities, each with a unique slug and a provincial program', () => {
    expect(allCities.length).toBeGreaterThan(0);
    const slugs = new Set(allCities.map((c) => c.slug));
    expect(slugs.size).toBe(allCities.length);
    for (const c of allCities) {
      expect(c.provincialProgram.name.trim().length).toBeGreaterThan(0);
      expect(c.provincialProgram.body.trim().length).toBeGreaterThan(0);
    }
  });

  // The review-before-index gate: unverified local content must NOT reach the
  // sitemap. A city goes live only when a human flips `published`.
  it('ships every city unpublished until human review', () => {
    expect(allCities.every((c) => c.published === false)).toBe(true);
    expect(publishedCities).toHaveLength(0);
  });

  it('universalIdeas includes the city’s provincial program', () => {
    const city = getCity('toronto');
    expect(city).toBeDefined();
    if (!city) return;
    const titles = universalIdeas(city).map((i) => i.title);
    expect(titles).toContain(city.provincialProgram.name);
  });
});

describe('activities structured data', () => {
  const city = getCity('vancouver');

  it('cityJsonLd emits Article + BreadcrumbList + FAQPage', () => {
    if (!city) throw new Error('fixture city missing');
    const types = (cityJsonLd(city)['@graph'] as Array<Record<string, unknown>>).map(
      (n) => n['@type'],
    );
    expect(types).toEqual(expect.arrayContaining(['Article', 'BreadcrumbList', 'FAQPage']));
  });

  it('hubJsonLd is a CollectionPage listing the given cities', () => {
    const ld = hubJsonLd(allCities);
    expect(ld['@type']).toBe('CollectionPage');
    const list = (ld.mainEntity as { itemListElement: unknown[] }).itemListElement;
    expect(list).toHaveLength(allCities.length);
  });
});
