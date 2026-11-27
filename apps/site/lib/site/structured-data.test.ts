import { describe, expect, it } from 'vitest';
import { routing } from '~/i18n/routing';
import { HALE_SAME_AS } from './social';
import { type JsonLdSaleClock, aboutJsonLd, pricingJsonLd, siteJsonLd } from './structured-data';

const OUTSIDE = new Date('2026-11-26T12:00:00.000Z');
const INSIDE = new Date('2026-11-27T12:00:00.000Z');
const AFTER = new Date('2026-11-28T08:00:00.000Z');
const FLAG_ON = { HOLIDAY_PROMO_ENABLED: 'true', VERCEL_ENV: 'production' };

const SEASON_CLOCK: JsonLdSaleClock = { now: OUTSIDE, env: FLAG_ON };
const SEASON_OFFERS = [
  { name: 'Plus', price: '59', priceCurrency: 'CAD', priceValidUntil: '2026-12-31' },
  { name: 'Max', price: '99', priceCurrency: 'CAD', priceValidUntil: '2026-12-31' },
  { name: 'Plus', price: '39', priceCurrency: 'USD', priceValidUntil: '2026-12-31' },
  { name: 'Max', price: '79', priceCurrency: 'USD', priceValidUntil: '2026-12-31' },
];
const ONE_DAY_OFFERS = [
  { name: 'Plus', price: '39', priceCurrency: 'CAD', priceValidUntil: '2026-12-31' },
  { name: 'Max', price: '59', priceCurrency: 'CAD', priceValidUntil: '2026-12-31' },
  { name: 'Plus', price: '29', priceCurrency: 'USD', priceValidUntil: '2026-12-31' },
  { name: 'Max', price: '49', priceCurrency: 'USD', priceValidUntil: '2026-12-31' },
];

function offerRows(node: Record<string, unknown>): Array<{
  name: string;
  price: string;
  priceCurrency: string;
  priceValidUntil: string;
}> {
  const offers = (node.offers ?? []) as Array<Record<string, string>>;
  return offers.map((offer) => ({
    name: offer.name ?? '',
    price: offer.price ?? '',
    priceCurrency: offer.priceCurrency ?? '',
    priceValidUntil: offer.priceValidUntil ?? '',
  }));
}

function siteOffers(clock: JsonLdSaleClock): Array<Record<string, string>> {
  const graph = siteJsonLd('en', clock)['@graph'] as Array<Record<string, unknown>>;
  const app = graph.find((node) => node['@type'] === 'SoftwareApplication');
  return offerRows(app ?? {});
}

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
    expect(siteOffers(SEASON_CLOCK)).toEqual(SEASON_OFFERS);
    expect(offerRows(pricingJsonLd('en', SEASON_CLOCK))).toEqual(SEASON_OFFERS);
    expect(JSON.stringify(siteJsonLd('en', SEASON_CLOCK))).not.toContain('"price":"0"');
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

describe('sale offers follow the Black Friday gate', () => {
  it('uses the one-day prices on the home and pricing graphs while the gate is open', () => {
    const open: JsonLdSaleClock = { now: INSIDE, env: FLAG_ON };
    expect(siteOffers(open)).toEqual(ONE_DAY_OFFERS);
    expect(offerRows(pricingJsonLd('en', open))).toEqual(ONE_DAY_OFFERS);
  });

  it('keeps the season prices when the gate is closed, the flag is off, or production ignores ?bf_now', () => {
    const closed: JsonLdSaleClock = { now: AFTER, env: FLAG_ON };
    const flagOff: JsonLdSaleClock = { now: INSIDE, env: { VERCEL_ENV: 'production' } };
    const preview: JsonLdSaleClock = {
      now: OUTSIDE,
      env: { ...FLAG_ON, VERCEL_ENV: 'preview' },
      search: { bf_now: INSIDE.toISOString() },
    };
    const ignored: JsonLdSaleClock = {
      now: OUTSIDE,
      env: FLAG_ON,
      search: { bf_now: INSIDE.toISOString() },
    };
    expect(siteOffers(closed)).toEqual(SEASON_OFFERS);
    expect(offerRows(pricingJsonLd('en', closed))).toEqual(SEASON_OFFERS);
    expect(siteOffers(flagOff)).toEqual(SEASON_OFFERS);
    expect(offerRows(pricingJsonLd('en', flagOff))).toEqual(SEASON_OFFERS);
    expect(siteOffers(preview)).toEqual(ONE_DAY_OFFERS);
    expect(offerRows(pricingJsonLd('en', preview))).toEqual(ONE_DAY_OFFERS);
    expect(siteOffers(ignored)).toEqual(SEASON_OFFERS);
    expect(offerRows(pricingJsonLd('en', ignored))).toEqual(SEASON_OFFERS);
  });
});
