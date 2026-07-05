import { describe, expect, it } from 'vitest';
import { siteJsonLd } from './structured-data';

describe('siteJsonLd', () => {
  const graph = siteJsonLd()['@graph'] as Array<Record<string, unknown>>;
  const byType = (t: string) => graph.find((n) => n['@type'] === t);

  it('emits the three site-identity nodes', () => {
    expect(graph).toHaveLength(3);
    expect(byType('Organization')).toBeDefined();
    expect(byType('WebSite')).toBeDefined();
    expect(byType('SoftwareApplication')).toBeDefined();
  });

  it('cross-links WebSite and the app to the Organization by @id', () => {
    const orgId = byType('Organization')?.['@id'];
    expect((byType('WebSite')?.publisher as { '@id': string })['@id']).toBe(orgId);
    expect((byType('SoftwareApplication')?.publisher as { '@id': string })['@id']).toBe(orgId);
  });

  it('declares the free tier as a concrete CAD Offer (the "is it free" AEO signal)', () => {
    const offer = byType('SoftwareApplication')?.offers as { price: string; priceCurrency: string };
    expect(offer.price).toBe('0');
    expect(offer.priceCurrency).toBe('CAD');
  });
});
