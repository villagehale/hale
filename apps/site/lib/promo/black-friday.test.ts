import { blackFridayCountdownRemainingMs } from '@hale/types';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PromoStickyCta } from '~/components/promo/holiday-promo';
import { RedesignHome } from '~/components/redesign/home';
import { RedesignPricing } from '~/components/redesign/pricing';
import {
  blackFridayCloseHeadline,
  blackFridayCountdownCopy,
  blackFridayCountdownPair,
  blackFridayEndsInCopy,
  blackFridayMaxHeadline,
  blackFridayPlanButton,
  blackFridayRenewalCopy,
  blackFridaySentence,
  resolveBlackFridayFromSearch,
  resolveBlackFridayOffer,
} from './black-friday';
import { buildHolidayPromo } from './holiday';

const IDS = {
  HOLIDAY_PROMO_ENABLED: 'true',
  STRIPE_PRICE_BF_PLUS_ANNUAL_CAD: 'price_bf_plus_cad',
  STRIPE_PRICE_BF_PLUS_ANNUAL_USD: 'price_bf_plus_usd',
  STRIPE_PRICE_BF_MAX_ANNUAL_CAD: 'price_bf_max_cad',
  STRIPE_PRICE_BF_MAX_ANNUAL_USD: 'price_bf_max_usd',
};

const door = {
  locale: 'en' as const,
  smsNumber: '+16475551234',
  prefill: 'Hi Hale',
  mode: 'chooser' as const,
};

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

describe('resolveBlackFridayOffer', () => {
  it('is off on either side of the window and on at both edges inside it', () => {
    const before = resolveBlackFridayOffer({
      now: new Date('2026-11-27T04:59:59.000Z'),
      country: 'US',
      env: IDS,
    });
    const start = resolveBlackFridayOffer({
      now: new Date('2026-11-27T05:00:00.000Z'),
      country: 'US',
      env: IDS,
    });
    const last = resolveBlackFridayOffer({
      now: new Date('2026-12-01T07:59:59.000Z'),
      country: 'CA',
      env: IDS,
    });
    const after = resolveBlackFridayOffer({
      now: new Date('2026-12-01T08:00:00.000Z'),
      country: 'US',
      env: IDS,
    });
    expect(before).toBeNull();
    expect(after).toBeNull();
    expect(start?.plus?.banner).toBe('$29');
    expect(start?.max?.banner).toBe('$49');
    expect(start?.plus).toMatchObject({
      regular: 39,
      sale: 29,
      regularLabel: '$39/yr',
      saleLabel: '$29/yr',
    });
    expect(last?.plus?.banner).toBe('$39');
    expect(last?.max?.banner).toBe('$59');
    expect(last?.max).toMatchObject({
      regular: 99,
      sale: 59,
      regularLabel: '$99/yr',
      saleLabel: '$59/yr',
    });
  });

  it('falls back to no sale when the price ids are missing', () => {
    expect(
      resolveBlackFridayOffer({
        now: new Date('2026-11-27T12:00:00.000Z'),
        country: 'CA',
        env: { HOLIDAY_PROMO_ENABLED: 'true' },
      }),
    ).toBeNull();
    const plusOnly = resolveBlackFridayOffer({
      now: new Date('2026-11-27T12:00:00.000Z'),
      country: 'CA',
      env: { HOLIDAY_PROMO_ENABLED: 'true', STRIPE_PRICE_BF_PLUS_ANNUAL_CAD: 'price_bf_plus_cad' },
    });
    expect(plusOnly?.plus?.banner).toBe('$39');
    expect(plusOnly?.max).toBeNull();
  });

  it('ignores ?bf, ?bf_now and the env override in production', () => {
    const env = {
      ...IDS,
      VERCEL_ENV: 'production',
      BLACK_FRIDAY_NOW_OVERRIDE: '2026-11-27T12:00:00.000Z',
    };
    expect(
      resolveBlackFridayFromSearch({
        now: new Date('2026-11-26T18:00:00.000Z'),
        country: 'US',
        env,
        search: { bf: '1', bf_now: '2026-11-27T12:00:00.000Z' },
      }),
    ).toBeNull();
  });

  it('lets ?bf=1 and ?bf_now open the sale on Preview', () => {
    const env = { ...IDS, VERCEL_ENV: 'preview' };
    const forced = resolveBlackFridayFromSearch({
      now: new Date('2026-11-26T18:00:00.000Z'),
      country: 'CA',
      env,
      search: { bf: '1' },
    });
    expect(forced?.plus?.banner).toBe('$39');
    expect(forced?.checkoutQuery).toBe('bf=1');
    const pinned = resolveBlackFridayFromSearch({
      now: new Date('2026-11-26T18:00:00.000Z'),
      country: 'US',
      env,
      search: { bf_now: '2026-12-01T07:59:59.000Z' },
    });
    expect(pinned?.max?.banner).toBe('$49');
    expect(
      resolveBlackFridayFromSearch({
        now: new Date('2026-11-26T18:00:00.000Z'),
        country: 'US',
        env,
        search: { bf_now: '2026-12-01T08:00:00.000Z' },
      }),
    ).toBeNull();
  });

  it('keeps BF prices after an ET Monday ends, and hides the midnight sentence', () => {
    const at = new Date('2026-12-01T04:59:59.000Z');
    const offer = resolveBlackFridayOffer({ now: at, country: 'US', env: IDS });
    expect(offer?.plus?.banner).toBe('$29');
    expect(offer?.max?.banner).toBe('$49');
    const remaining = blackFridayCountdownRemainingMs(at.getTime(), 'America/New_York');
    expect(remaining).toBe(0);
    expect(blackFridayCountdownCopy('en', remaining)).toBeNull();
    expect(blackFridayCountdownCopy('fr', remaining)).toBeNull();
    expect(blackFridayCountdownCopy('zh', remaining)).toBeNull();
    expect(blackFridayCountdownCopy('en', remaining - 1)).toBeNull();
    expect(blackFridayCountdownCopy('en', 1)).toBe('Ends in');
    expect(blackFridayCountdownCopy('fr', 1)).toBe('Fin dans');
    expect(blackFridayCountdownCopy('zh', 1)).toBe('距结束');
    expect(blackFridayCountdownPair('en', 0)).toBeNull();
    expect(blackFridayCountdownPair('fr', (26 * 3600 + 60 + 1) * 1000)).toEqual({
      when: 'Fin dans',
      left: 'Fin dans 26:01:01',
    });
    expect(blackFridayEndsInCopy('zh', '00:00:00')).toBe('距结束 00:00:00');
    expect(blackFridayEndsInCopy('en', '01:02:03')).toBe('Ends in 01:02:03');
    expect(blackFridayRenewalCopy('en', '$39/yr', '$59/yr')).toBe(
      'Plus is $39/yr and Max is $59/yr today. This price stays when you renew.',
    );
    expect(blackFridayRenewalCopy('fr', '$39/yr', '$59/yr')).toBe(
      "Plus coûte 39 $/an et Max coûte 59 $/an aujourd'hui. Ce prix reste quand tu renouvelles.",
    );
    expect(blackFridayRenewalCopy('zh', '$29/yr', '$49/yr')).toBe(
      '今日 Plus 每年 $29，Max 每年 $49。续订时这个价格不变。',
    );
    expect(blackFridayRenewalCopy('en', '$39/yr', '$59/yr')).not.toMatch(/Dec 31|\$99|for life|locked in/i);
    expect(blackFridayPlanButton('en', 'plus', '$39/yr')).toBe('Get Plus, $39/yr');
    expect(blackFridayPlanButton('en', 'max', '$59/yr')).toBe('Get Max, $59/yr');
    expect(blackFridayPlanButton('fr', 'plus', '$39/yr')).toBe('Prends Plus, 39 $/an');
    expect(blackFridayPlanButton('zh', 'max', '$49/yr')).toBe('开通 Max，每年 $49');
    expect(blackFridayMaxHeadline('fr', '$59/yr')).toBe('Black Friday : Max à 59 $/an.');
    expect(blackFridayCloseHeadline('zh', '$49/yr')).toBe('今日 Max 每年 $49。');
  });
});

describe('sticky promo bar', () => {
  const promo = buildHolidayPromo('black_friday', 'USD');
  const canada = buildHolidayPromo('black_friday', 'CAD');

  function bar(
    at: string,
    country: 'US' | 'CA',
    search?: { bf?: string; bf_now?: string },
    env: Record<string, string | undefined> = IDS,
  ) {
    const offer = resolveBlackFridayFromSearch({
      now: new Date(at),
      country,
      env,
      search,
    });
    const shown = country === 'CA' ? canada : promo;
    return text(
      renderToStaticMarkup(
        createElement(PromoStickyCta, { ...door, promo: shown, blackFriday: offer }),
      ),
    );
  }

  it('keeps the season bar on both sides of the window and replaces it inside', () => {
    const before = bar('2026-11-27T04:59:59.000Z', 'US');
    expect(before).toContain('Black Friday Sale');
    expect(before).toContain('Max $79/yr, Plus $39/yr');
    expect(before).toContain('Join by Dec 31');
    expect(before).not.toContain('Plus $29');

    const start = bar('2026-11-27T05:00:00.000Z', 'US');
    expect(start).toContain('Plus $29 · Max $49');
    expect(start).toContain('88');
    expect(start).toContain('hrs');
    expect(start).toContain('Ends at midnight.');
    expect(start).toContain('See prices');
    expect(start).toContain('×');
    expect(start).not.toContain('Ends in');
    expect(start).not.toContain('/yr');
    expect(start).not.toContain('Text Hale');
    expect(start).not.toContain('ended');
    expect(start).not.toContain('expired');
    expect(start).not.toContain('Join by Dec 31');
    expect(start).not.toContain('$79/yr');

    const canadaStart = bar('2026-11-27T05:00:00.000Z', 'CA');
    expect(canadaStart).toContain('Plus $39 · Max $59');
    expect(canadaStart).toContain('Ends at midnight.');
    expect(canadaStart).not.toContain('/yr');
    expect(canadaStart).not.toContain('$99');
    expect(canadaStart).not.toMatch(/C\$|US\$/);

    const afterEtMidnight = bar('2026-12-01T04:59:59.000Z', 'US');
    expect(afterEtMidnight).toContain('Plus $29 · Max $49');
    expect(afterEtMidnight).toContain('Ends at midnight.');
    expect(afterEtMidnight).not.toContain('ended');
    expect(afterEtMidnight).not.toContain('Join by Dec 31');

    const after = bar('2026-12-01T08:00:00.000Z', 'US');
    expect(after).toContain('Max $79/yr, Plus $39/yr');
    expect(after).toContain('Join by Dec 31');
    expect(after).not.toContain('Plus $29');
  });

  it('lets ?bf=1 replace the bar on Preview and ignores it in production', () => {
    const forced = bar(
      '2026-11-26T18:00:00.000Z',
      'CA',
      { bf: '1' },
      { ...IDS, VERCEL_ENV: 'preview' },
    );
    expect(forced).toContain('Plus $39 · Max $59');
    expect(forced).not.toContain('Join by Dec 31');

    const hidden = bar(
      '2026-11-26T18:00:00.000Z',
      'US',
      { bf: '1', bf_now: '2026-12-01T06:00:00.000Z' },
      { ...IDS, VERCEL_ENV: 'preview' },
    );
    expect(hidden).toContain('Plus $29 · Max $49');
    expect(
      blackFridayCountdownCopy(
        'en',
        blackFridayCountdownRemainingMs(Date.parse('2026-12-01T06:00:00.000Z'), 'America/New_York'),
      ),
    ).toBeNull();
    expect(hidden).not.toContain('ended');
    expect(hidden).not.toContain('Join by Dec 31');

    const production = bar(
      '2026-11-26T18:00:00.000Z',
      'US',
      { bf: '1', bf_now: '2026-11-27T12:00:00.000Z' },
      { ...IDS, VERCEL_ENV: 'production', BLACK_FRIDAY_NOW_OVERRIDE: '2026-11-27T12:00:00.000Z' },
    );
    expect(production).toContain('Max $79/yr, Plus $39/yr');
    expect(production).toContain('Join by Dec 31');
    expect(production).not.toContain('Plus $29');
  });

  it('uses the visitor region and stays quiet about a price it cannot charge', () => {
    expect(blackFridaySentence('en', '$39', '$59')).toBe(
      'Black Friday: yearly Plus $39 and Max $59, today only.',
    );
    expect(blackFridaySentence('fr', '$39', '$59')).toContain("aujourd'hui seulement");
    expect(blackFridaySentence('zh', '$29', '$49')).toContain('仅限今日');
    expect(blackFridaySentence('en', '$39', '$59')).not.toMatch(/C\$|US\$|founding|first\s100/i);
  });
});

describe('in-window pages name only today’s price', () => {
  const at = new Date('2026-11-27T18:00:00.000Z');
  const canada = resolveBlackFridayOffer({ now: at, country: 'CA', env: IDS });
  const promo = buildHolidayPromo('black_friday', 'CAD');
  const door = { smsNumber: '+16475551234', prefill: 'Hi Hale' };

  function page(locale: 'en' | 'fr' | 'zh', withPromo: boolean) {
    const props = { ...door, locale, promo: withPromo ? promo : null, blackFriday: canada };
    const homeHtml = renderToStaticMarkup(createElement(RedesignHome, props));
    const pricingHtml = renderToStaticMarkup(createElement(RedesignPricing, props));
    return {
      home: text(homeHtml),
      pricing: text(pricingHtml),
      homeHtml,
      pricingHtml,
    };
  }

  it('keeps the strike and drops every season-price sentence on the English body', () => {
    const { home, pricing, homeHtml, pricingHtml } = page('en', true);
    for (const body of [home, pricing]) {
      expect(body).toContain('Plus is $39/yr and Max is $59/yr today. This price stays when you renew.');
      expect(body).toContain('Ends in');
      expect(body).toContain('Ends at midnight.');
      expect(body).toContain('See prices');
      expect(body).not.toMatch(/Join by Dec 31|Lock in|for as long as|locked in for life|After today/i);
      expect(body).not.toContain('Plus is $59');
      expect(body).not.toContain('Max is $99');
    }
    expect(pricing).toContain('Get Plus, $39/yr');
    expect(pricing).toContain('Get Max, $59/yr');
    expect(home).toContain('Get Max, $59/yr');
    for (const html of [homeHtml, pricingHtml]) {
      expect(html).toContain('href="/pricing"');
      expect(html).toContain('<s>$59</s>');
      expect(html).toContain('<s>$99</s>');
    }
    expect(pricingHtml).toContain('<s class="promo-tier-regular">$59/yr</s>');
    expect(pricingHtml).toContain('<s class="promo-tier-regular">$99/yr</s>');
    expect(homeHtml).toContain('aria-label="Close"');
    for (const marker of ['bf-banner', 'bf-sticky']) {
      const chunk = homeHtml.slice(homeHtml.indexOf(marker));
      const linkEnd = chunk.indexOf('</a>');
      const button = chunk.indexOf('<button');
      expect(linkEnd).toBeGreaterThan(0);
      expect(button).toBeGreaterThan(linkEnd);
      expect(chunk.slice(0, linkEnd)).not.toContain('<button');
    }
  });

  it('localizes the French and Chinese pricing page, including the countdown', () => {
    const french = page('fr', false);
    const fr = french.pricing;
    expect(fr).toContain('Black Friday : Max à 59 $/an.');
    expect(fr).toContain('Prends Plus, 39 $/an');
    expect(fr).toContain('Prends Max, 59 $/an');
    expect(fr).toContain("Ce prix reste quand tu renouvelles.");
    expect(fr).toContain("si ce n'est pas pour toi.");
    expect(fr).toContain('Fin dans');
    expect(fr).toContain('Se termine à minuit.');
    expect(fr).toContain('Voir les prix');
    expect(fr).toContain('39 $/an');
    expect(fr).toContain('Plus 39 $ · Max 59 $');
    expect(french.pricingHtml).toContain('href="/fr/pricing"');
    expect(french.pricingHtml).toContain('aria-label="Fermer"');
    expect(fr).not.toContain('Fin vendredi');
    expect(fr).not.toContain('Ends at midnight');
    expect(fr).not.toMatch(
      /Lock in|Get Plus|Get Max|Join by Dec|Ends Friday|Ends in|Today only|regular price| a year|Billed yearly|Black Friday:|Max for |This price stays/,
    );

    const chinese = page('zh', false);
    const zh = chinese.pricing;
    expect(zh).toContain('黑色星期五：Max 每年 $59。');
    expect(zh).toContain('开通 Plus，每年 $39');
    expect(zh).toContain('开通 Max，每年 $59');
    expect(zh).toContain('续订时这个价格不变。');
    expect(zh).toContain('距结束');
    expect(zh).toContain('午夜结束。');
    expect(zh).toContain('查看价格');
    expect(zh).toContain('Plus $39 · Max $59');
    expect(chinese.pricingHtml).toContain('href="/zh/pricing"');
    expect(chinese.pricingHtml).toContain('aria-label="关闭"');
    expect(zh).not.toMatch(
      /Lock in|Get Plus|Get Max|Join by Dec|Ends Friday|Ends in|Today only|regular price|Black Friday:|Max for |This price stays/,
    );
  });
});
