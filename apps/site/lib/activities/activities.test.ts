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

  // The review-before-index gate: only reviewed cities are exposed to the sitemap.
  // publishedCities must be exactly the `published` subset — never a page the flag
  // says is unreviewed.
  it('publishedCities are exactly the reviewed (published) cities', () => {
    expect(publishedCities.every((c) => c.published)).toBe(true);
    expect(publishedCities).toHaveLength(allCities.filter((c) => c.published).length);
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
