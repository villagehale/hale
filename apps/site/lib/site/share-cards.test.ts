import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PROMO_PRICE_DISPLAY, currencyFromIpCountry } from '@hale/types';
import { describe, expect, it, vi } from 'vitest';
import { tx } from '~/components/redesign/tx';
import { H1 } from '~/lib/site/narrative';
import type { Locale } from '~/i18n/routing';
import { allAnswers } from '~/lib/answers/index';
import { buildHolidayPromo } from '~/lib/promo/holiday';
import { generateMetadata as pricingMetadata } from '../../app/[locale]/pricing/page';
import {
  HOME_CARD,
  HOME_SLOGAN,
  SHARE_CARD_IDS,
  SHARE_CARD_VERSION,
  type ShareCardQuery,
  paintAnswerCard,
  paintShareCard,
  shareCardQueryFrom,
  shareCardQueryString,
  shareCardVisibleText,
  sharePriceLabel,
} from './share-cards';

const LOCALES: Locale[] = ['en', 'fr', 'zh'];
const PHASES = ['black_friday', 'holiday'] as const;
const CURRENCIES = ['CAD', 'USD'] as const;

/** Phrases that must not appear on a card. The page descriptions are a different surface. */
const priceWord = 'fr' + 'ee';
const BANNED = new RegExp(
  [
    'biggest sale of the year',
    "your kids[’'] year,\\s*handled",
    "kids[’'] year",
    'lowest price of the year',
    `\\b${priceWord}\\b`,
    'founding',
    'first\\s*100',
    'gratuit',
    'fondat',
    '免费',
    '创始',
    '前\\s*100',
    'AI agent',
    '\\bmonth\\b',
    '\\bmonthly\\b',
    '\\bmois\\b',
    '按月',
    '/mo\\b',
  ].join('|'),
  'i',
);

function query(partial: Partial<ShareCardQuery> & Pick<ShareCardQuery, 'locale'>): ShareCardQuery {
  return {
    phase: 'black_friday',
    currency: 'CAD',
    offer: false,
    paid: false,
    ...partial,
  };
}

describe('share card query', () => {
  const on = { HOLIDAY_PROMO_ENABLED: 'true', VERCEL_ENV: 'production' };

  it('is Black Friday through Nov 30 and Holiday from Dec 1, Toronto', () => {
    const before = shareCardQueryFrom({
      locale: 'en',
      now: new Date('2026-11-30T23:59:59-05:00'),
      env: on,
    });
    const after = shareCardQueryFrom({
      locale: 'en',
      now: new Date('2026-12-01T00:00:00-05:00'),
      env: on,
    });
    expect(before.phase).toBe('black_friday');
    expect(before.offer).toBe(true);
    expect(after.phase).toBe('holiday');
    expect(after.offer).toBe(true);
  });

  it('stays off in production when the flag is off, and ignores a review query there', () => {
    const card = shareCardQueryFrom({
      locale: 'en',
      now: new Date('2026-11-20T12:00:00-05:00'),
      search: { promo_phase: 'holiday' },
      env: { VERCEL_ENV: 'production' },
    });
    expect(card.offer).toBe(false);
    expect(card.phase).toBe('black_friday');
  });

  it('lets a preview review query force the holiday card', () => {
    const card = shareCardQueryFrom({
      locale: 'en',
      now: new Date('2026-11-20T12:00:00-05:00'),
      search: { promo_phase: 'holiday', promo_cc: 'US' },
      env: { VERCEL_ENV: 'preview' },
    });
    expect(card).toMatchObject({ locale: 'en', phase: 'holiday', currency: 'USD', offer: true });
  });

  it('leaves the offer off in French and Chinese, including a preview review query', () => {
    for (const locale of ['fr', 'zh'] as const) {
      const card = shareCardQueryFrom({
        locale,
        now: new Date('2026-11-25T12:00:00-05:00'),
        search: { promo_phase: 'black_friday', promo_cc: 'CA' },
        country: 'US',
        env: { HOLIDAY_PROMO_ENABLED: 'true', VERCEL_ENV: 'preview' },
      });
      expect(card.offer, locale).toBe(false);
    }
  });

  it('puts the phase and the version on the image URL', () => {
    const card = query({ locale: 'zh', phase: 'holiday', currency: 'USD', offer: true });
    expect(shareCardQueryString(card)).toBe(
      `v=${SHARE_CARD_VERSION}&locale=zh&phase=holiday&cc=USD&offer=1&paid=0`,
    );
  });

  it('uses CAD when no country is known, the same default as the site', () => {
    const now = new Date('2026-11-25T12:00:00-05:00');
    const env = { HOLIDAY_PROMO_ENABLED: 'true', VERCEL_ENV: 'production' };
    expect(currencyFromIpCountry(null)).toBe('CAD');
    expect(shareCardQueryFrom({ locale: 'en', now, country: null, env }).currency).toBe('CAD');
    expect(
      shareCardQueryFrom({
        locale: 'en',
        now,
        env: { ...env, CHECKOUT_SERVER_CURRENCY_ENABLED: 'true' },
      }).currency,
    ).toBe('CAD');
  });
});

describe('share card copy', () => {
  it('paints the shared promo prices, in both currencies', () => {
    for (const currency of CURRENCIES) {
      const promo = buildHolidayPromo('holiday', currency);
      const card = paintShareCard(
        'home',
        query({ locale: 'en', currency, offer: true, phase: 'holiday' }),
      );
      const max = sharePriceLabel(currency, promo.max.saleLabel);
      const plus = sharePriceLabel(currency, promo.plus.saleLabel);
      expect(card.prices).toBe(`Max ${max} · Plus ${plus}`);
      const symbol = currency === 'CAD' ? 'C$' : '$';
      expect(card.prices).toBe(
        `Max ${symbol}${PROMO_PRICE_DISPLAY.family[currency].amount}/yr · Plus ${symbol}${PROMO_PRICE_DISPLAY.plus[currency].amount}/yr`,
      );
      expect(card.prices).not.toContain('US$');
      expect(card.flag).toBe('Holiday Sale');
    }
  });

  it('uses the pricing page H1 when the offer is on in English, and the yearly line otherwise', () => {
    const promo = buildHolidayPromo('black_friday', 'CAD');
    const on = paintShareCard('pricing', query({ locale: 'en', offer: true }));
    expect(on.headline).toBe(
      `${promo.saleName}: Max for ${sharePriceLabel('CAD', promo.max.saleLabel)}.`,
    );
    expect(on.headline).toBe('Black Friday Sale: Max for C$99/yr.');
    expect(
      paintShareCard('pricing', query({ locale: 'en', offer: true, currency: 'USD' })).headline,
    ).toBe('Black Friday Sale: Max for $79/yr.');
    expect(paintShareCard('pricing', query({ locale: 'en', offer: false })).headline).toBe(
      'More done for you, all year.',
    );
    expect(paintShareCard('pricing', query({ locale: 'fr', offer: true })).headline).toBe(
      tx('fr', 'More done for you, all year.'),
    );
    expect(paintShareCard('pricing', query({ locale: 'zh', offer: true })).headline).toBe(
      tx('zh', 'More done for you, all year.'),
    );
  });

  it('paints no sale chip and no promo prices on French or Chinese cards', () => {
    for (const locale of ['fr', 'zh'] as const) {
      for (const phase of PHASES) {
        for (const id of SHARE_CARD_IDS) {
          const card = paintShareCard(
            id,
            query({
              locale,
              offer: true,
              phase,
              currency: 'USD',
              paid: id === 'checkout',
            }),
          );
          expect(card.flag, `${locale} ${phase} ${id}`).toBeNull();
          expect(card.prices, `${locale} ${phase} ${id}`).toBeNull();
        }
      }
    }
  });

  it('localizes subpage headlines with the page strings', () => {
    expect(paintShareCard('faq', query({ locale: 'fr' })).headline).toBe(
      tx('fr', 'Is Hale right for your family?'),
    );
    expect(paintShareCard('faq', query({ locale: 'zh' })).headline).toBe(
      tx('zh', 'Is Hale right for your family?'),
    );
    expect(paintShareCard('about', query({ locale: 'en' })).headline).toBe(HOME_SLOGAN.en.plain);
    expect(paintShareCard('about', query({ locale: 'fr' })).headline).toBe(HOME_SLOGAN.fr.plain);
    expect(paintShareCard('about', query({ locale: 'zh' })).headline).toBe(HOME_SLOGAN.zh.plain);
    expect(paintShareCard('activities', query({ locale: 'fr' })).headline).toBe(
      tx('fr', 'Things to do with your kids, near you.'),
    );
  });

  it('puts Priya first, then the class, then the yes, in each locale', () => {
    const en = paintShareCard('home', query({ locale: 'en' })).chat.lines.map((line) => line.text);
    expect(en).toEqual([
      'we should do something saturday',
      'toddler swim',
      'saturday, 10am',
      'at the community centre',
      'we’re in',
    ]);
    expect(
      paintShareCard('home', query({ locale: 'fr' })).chat.lines.map((line) => line.text),
    ).toEqual([
      'on devrait faire quelque chose samedi',
      'natation pour les tout-petits',
      'samedi à 10 h',
      'au centre communautaire',
      'on est partants',
    ]);
    expect(
      paintShareCard('home', query({ locale: 'zh' })).chat.lines.map((line) => line.text),
    ).toEqual(['我们周六应该做点什么', '幼儿游泳', '周六上午 10 点', '在社区中心', '我们去']);
  });

  it('paints the new hero on the home card in each locale', () => {
    for (const locale of LOCALES) {
      const card = paintShareCard('home', query({ locale }));
      expect(card.headline, locale).toBe(tx(locale, H1));
      expect(card.alt, locale).toBe(`Hale. ${tx(locale, H1)}`);
      expect(card.slogan?.marked, locale).toBe(HOME_CARD[locale].marked);
      expect(card.headline, locale).not.toContain("we should");
    }
    expect(HOME_CARD.en.plain).toBe(H1);
    expect(HOME_CARD.en.marked).toBe('Now it’s Hale.');
  });

  it('keeps the older group-chat line on the about card', () => {
    const line = 'From \u201cwe should\u201d to \u201cwe\u2019re in.\u201d';
    for (const locale of LOCALES) {
      expect(HOME_SLOGAN[locale].plain, locale).toBe(tx(locale, line));
      expect(paintShareCard('about', query({ locale })).headline, locale).toBe(tx(locale, line));
    }
  });

  it('breaks the French headline into two lines and keeps the Chinese break', () => {
    const nbsp = '\u00A0';
    expect(HOME_SLOGAN.fr.lead).toBe(`De «${nbsp}on${nbsp}devrait${nbsp}»`);
    expect(HOME_SLOGAN.fr.quote).toBe('');
    expect(HOME_SLOGAN.fr.bridge).toBe('à');
    expect(HOME_SLOGAN.fr.marked).toBe(`«${nbsp}on${nbsp}y${nbsp}va${nbsp}».`);
    expect(HOME_SLOGAN.zh.lead).toBe('从“改天吧”');
    expect(HOME_SLOGAN.zh.quote).toBe('');
    expect(HOME_SLOGAN.zh.bridge).toBe('');
    expect(HOME_SLOGAN.zh.marked).toBe('到“就这么定了”。');
    const about = paintShareCard('about', query({ locale: 'fr' }));
    expect(about.slogan?.lead).toBe(HOME_SLOGAN.fr.lead);
    expect(about.slogan?.marked).toBe(HOME_SLOGAN.fr.marked);
  });

  it('paints no banned phrase on any page, locale, phase, or article', () => {
    const blobs: string[] = [];
    for (const locale of LOCALES) {
      for (const phase of PHASES) {
        for (const currency of CURRENCIES) {
          for (const offer of [false, true]) {
            for (const id of SHARE_CARD_IDS) {
              blobs.push(
                shareCardVisibleText(
                  paintShareCard(
                    id,
                    query({ locale, phase, currency, offer, paid: id === 'checkout' }),
                  ),
                ),
              );
            }
            for (const page of allAnswers) {
              blobs.push(
                shareCardVisibleText(
                  paintAnswerCard(page.question, query({ locale, phase, currency, offer })),
                ),
              );
            }
          }
        }
      }
    }
    const hit = blobs.find((blob) => BANNED.test(blob));
    expect(hit?.match(BANNED)?.[0] ?? '').toBe('');
  });

  it('does not write a banned phrase into the generator source', () => {
    const source = [
      readFileSync(fileURLToPath(new URL('./share-cards.ts', import.meta.url)), 'utf8'),
      readFileSync(fileURLToPath(new URL('./share-card.tsx', import.meta.url)), 'utf8'),
    ].join('\n');
    expect(source).not.toMatch(BANNED);
  });
});

describe('pricing metadata image', () => {
  it('follows a preview holiday query into the image URL', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-20T15:00:00-05:00'));
    const previous = process.env.VERCEL_ENV;
    process.env.VERCEL_ENV = 'preview';
    try {
      const meta = await pricingMetadata({
        params: Promise.resolve({ locale: 'en' as const }),
        searchParams: Promise.resolve({ promo_phase: 'holiday' }),
      });
      const images = meta.openGraph?.images;
      const first = Array.isArray(images) ? images[0] : images;
      const url = first && typeof first === 'object' && 'url' in first ? String(first.url) : '';
      expect(url).toContain('phase=holiday');
      expect(url).toContain('offer=1');
      expect(url).toContain(`v=${SHARE_CARD_VERSION}`);
      expect(meta.twitter && 'card' in meta.twitter ? meta.twitter.card : '').toBe(
        'summary_large_image',
      );
    } finally {
      process.env.VERCEL_ENV = previous;
      vi.useRealTimers();
    }
  });
});
