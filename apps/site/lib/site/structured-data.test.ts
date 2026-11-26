import { describe, expect, it } from 'vitest';
import { routing } from '~/i18n/routing';
import { HALE_SAME_AS } from './social';
import { aboutJsonLd, siteJsonLd } from './structured-data';

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

  it('lists Hale’s profiles on the Organization and no phone number', () => {
    const org = byType('Organization');
    expect(org?.sameAs).toEqual([...HALE_SAME_AS]);
    expect(org).not.toHaveProperty('telephone');
    expect(JSON.stringify(siteJsonLd())).not.toContain('telephone');
    const about = aboutJsonLd().about as Record<string, unknown>;
    expect(about.sameAs).toEqual([...HALE_SAME_AS]);
    expect(about).not.toHaveProperty('telephone');
  });

  it('does not name a country of service', () => {
    expect(byType('Organization')).not.toHaveProperty('areaServed');
    const json = JSON.stringify(siteJsonLd());
    expect(json).not.toContain('areaServed');
    expect(json).not.toContain('Country');
  });

  it('declares the Canada and US sale offers through Dec 31', () => {
    const offers = byType('SoftwareApplication')?.offers as Array<Record<string, string>>;
    expect(offers).toEqual([
      expect.objectContaining({ name: 'Plus', price: '59', priceCurrency: 'CAD', priceValidUntil: '2026-12-31' }),
      expect.objectContaining({ name: 'Max', price: '99', priceCurrency: 'CAD', priceValidUntil: '2026-12-31' }),
      expect.objectContaining({ name: 'Plus', price: '39', priceCurrency: 'USD', priceValidUntil: '2026-12-31' }),
      expect.objectContaining({ name: 'Max', price: '79', priceCurrency: 'USD', priceValidUntil: '2026-12-31' }),
    ]);
    expect(JSON.stringify(siteJsonLd())).not.toContain('"price":"0"');
  });

  it.each(routing.locales)('%s describes the org and the app with the one-liner', (locale) => {
    const nodes = siteJsonLd(locale)['@graph'] as Array<Record<string, unknown>>;
    const org = nodes.find((n) => n['@type'] === 'Organization');
    const app = nodes.find((n) => n['@type'] === 'SoftwareApplication');
    const oneLiner = {
      en: 'Hale is the AI agent for family life. It knows your kids, finds what fits, signs them up with your ok, and handles the schedule, the driving and the other parents.',
      fr: 'Hale est l’agent IA pour la vie de famille. Il connaît tes enfants, trouve ce qui leur va, les inscrit avec ton accord, et s’occupe de l’horaire, des trajets et des autres parents.',
      zh: 'Hale 是家庭生活的 AI 智能体。它了解你家的孩子，找到合适的，经你同意帮他们报名，并处理日程、接送和其他家长。',
    }[locale];
    expect(org?.description).toBe(oneLiner);
    expect(app?.description).toBe(oneLiner);
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
