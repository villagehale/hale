import { describe, expect, it } from 'vitest';
import { routing } from '~/i18n/routing';
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

  it('does not name a country of service', () => {
    expect(byType('Organization')).not.toHaveProperty('areaServed');
    const json = JSON.stringify(siteJsonLd());
    expect(json).not.toContain('areaServed');
    expect(json).not.toContain('Country');
  });

  it('declares a zero-price CAD Offer', () => {
    const offer = byType('SoftwareApplication')?.offers as { price: string; priceCurrency: string };
    expect(offer.price).toBe('0');
    expect(offer.priceCurrency).toBe('CAD');
  });

  it.each(routing.locales)('%s describes the agent, H1 first', (locale) => {
    const nodes = siteJsonLd(locale)['@graph'] as Array<Record<string, unknown>>;
    const org = nodes.find((n) => n['@type'] === 'Organization');
    const app = nodes.find((n) => n['@type'] === 'SoftwareApplication');
    const h1 = {
      en: 'Your kids’ year, handled.',
      fr: 'L’année de tes enfants, sans casse-tête.',
      zh: '孩子这一年，交给 Hale。',
    }[locale];
    const agent = {
      en: 'AI agent you text',
      fr: 'agent d’IA',
      zh: 'AI 代理',
    }[locale];
    expect(String(app?.description).startsWith(h1)).toBe(true);
    expect(org?.description).toContain(agent);
    expect(app?.description).toContain(agent);
    const blob = `${org?.description} ${app?.description}`.toLowerCase();
    for (const banned of [
      'village your family lost',
      'passive multi-agent',
      'multi-agent',
      'family ai',
      'activity finder',
      'chief of staff',
      'assistant',
    ]) {
      expect(blob, banned).not.toContain(banned);
    }
  });
});
