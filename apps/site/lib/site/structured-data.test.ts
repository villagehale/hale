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

  it('lists one free offer at 0 CAD and no paid offers', () => {
    for (const locale of routing.locales) {
      const nodes = siteJsonLd(locale)['@graph'] as Array<Record<string, unknown>>;
      const app = nodes.find((n) => n['@type'] === 'SoftwareApplication');
      expect(app?.offers).toEqual({ '@type': 'Offer', price: '0', priceCurrency: 'CAD' });
      const serialized = JSON.stringify(siteJsonLd(locale));
      expect(serialized.match(/"@type":"Offer"/g)).toHaveLength(1);
      expect(serialized).not.toMatch(/"price":"(?!0")/);
      expect(serialized).not.toContain('$');
    }
  });

  it.each(routing.locales)('%s describes a kids-year planner, find first', (locale) => {
    const nodes = siteJsonLd(locale)['@graph'] as Array<Record<string, unknown>>;
    const org = nodes.find((n) => n['@type'] === 'Organization');
    const app = nodes.find((n) => n['@type'] === 'SoftwareApplication');
    const h1 = {
      en: 'Find what’s on. Hear how it went.',
      fr: 'Trouvez ce qu’il y a. Écoutez comment ça va.',
      zh: '看看有什么。听听怎么样。',
    }[locale];
    const planner = {
      en: 'planner for your kids’ year',
      fr: "planificateur pour l'annee de vos enfants",
      zh: '孩子这一年的规划',
    }[locale];
    expect(String(app?.description).startsWith(h1)).toBe(true);
    expect(org?.description).toContain(planner);
    expect(app?.description).toContain(planner);
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
