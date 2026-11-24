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

  it('does not declare a zero-price offer', () => {
    expect(byType('SoftwareApplication')).not.toHaveProperty('offers');
    expect(JSON.stringify(siteJsonLd())).not.toContain('"price":"0"');
  });

  it.each(routing.locales)('%s describes the org and the app with the one-liner', (locale) => {
    const nodes = siteJsonLd(locale)['@graph'] as Array<Record<string, unknown>>;
    const org = nodes.find((n) => n['@type'] === 'Organization');
    const app = nodes.find((n) => n['@type'] === 'SoftwareApplication');
    const oneLiner = {
      en: "Hale finds real classes and plans near you for your kids' ages, and gets the group chat to a yes.",
      fr: "Hale trouve de vraies activités près de chez vous pour l'âge de vos enfants, et amène le groupe à un oui.",
      zh: 'Hale 帮你找到附近适合孩子年龄的真实活动，让家长群一起定下来。',
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
