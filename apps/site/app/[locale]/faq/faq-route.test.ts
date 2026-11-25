import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FAQ } from '~/lib/faq/index.js';
import FaqPage from './page.js';

const messages = (name: string) =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(`../../../messages/${name}.json`, import.meta.url)), 'utf8'),
  ) as {
    Faq: { metaTitle: string; metaDescription: string };
  };

const html = renderToStaticMarkup(
  await FaqPage({ params: Promise.resolve({ locale: 'en' as const }) }),
);

describe('/faq — canonical product FAQ', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('renders every product question once in the visible accordion', () => {
    for (const item of FAQ) {
      expect(html).toContain(item.question);
    }
  });

  it('keeps FAQPage structured data on the canonical route', () => {
    expect(html).toContain('application/ld+json');
    expect(html).toContain('"@type":"FAQPage"');
  });

  /**
   * Every answer is in the server HTML, inside a native <details> that starts
   * closed. With JavaScript off the row still opens, and a crawler still sees
   * the full list. Nothing carries `open` or `name`.
   */
  it('prints every question in the server HTML, collapsed, so it is readable with JavaScript off', () => {
    for (const item of FAQ) {
      expect(html).toContain(item.question);
    }
    const details = html.match(/<details\b[^>]*>/g) ?? [];
    expect(details).toHaveLength(FAQ.length);
    for (const tag of details) {
      expect(tag).not.toMatch(/\sopen(?:=|\s|>)/);
      expect(tag).not.toContain('name=');
    }
  });

  it('locks the share description in English, French, and Chinese', () => {
    expect(messages('en').Faq.metaDescription).toBe(
      'What Hale does, what it reads, how it keeps your family’s data private, and why it never signs up or pays without your ok.',
    );
    expect(messages('fr').Faq.metaDescription).toBe(
      'Ce que fait Hale, ce qu’elle lit, comment elle garde privées les données de ta famille, et pourquoi elle n’inscrit personne et ne paie pas sans ton accord.',
    );
    expect(messages('zh').Faq.metaDescription).toBe(
      'Hale 做什么、读什么、如何保护你家的数据，以及为什么没有你的同意它不会报名或付款。',
    );
    expect(messages('en').Faq.metaTitle).toBe('Questions about Hale · Hale');
  });

  it('states the yearly price in each locale, in the row and the JSON-LD', async () => {
    const cases = [
      ['en', 'Plus is $159/yr, and Max is $329/yr.', '$19/mo'],
      ['fr', 'Plus coûte 159 $/an, et Max coûte 329 $/an.', '19 $/mois'],
      ['zh', 'Plus 是每年 $159，Max 是每年 $329。', '每月 $19'],
    ] as const;
    for (const [locale, yearly, monthly] of cases) {
      const page = renderToStaticMarkup(
        await FaqPage({ params: Promise.resolve({ locale }) }),
      );
      expect(page, locale).toContain(yearly);
      expect(page, locale).not.toContain(monthly);
      const ld = page.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1] ?? '';
      expect(ld, locale).toContain(yearly);
      expect(ld, locale).not.toContain(monthly);
    }
  });

  it('shows the English sale price while the promo runs, and keeps fr and zh on the list yearly price', async () => {
    vi.stubEnv('HOLIDAY_PROMO_ENABLED', 'true');
    const en = renderToStaticMarkup(await FaqPage({ params: Promise.resolve({ locale: 'en' }) }));
    const fr = renderToStaticMarkup(await FaqPage({ params: Promise.resolve({ locale: 'fr' }) }));
    const zh = renderToStaticMarkup(await FaqPage({ params: Promise.resolve({ locale: 'zh' }) }));
    expect(en).toContain('Plus is $59/yr, and Max is $99/yr.');
    expect(en).not.toContain('$19/mo');
    expect(en).not.toContain('$159/yr');
    expect(fr).toContain('159 $/an');
    expect(fr).not.toContain('$59/yr');
    expect(fr).not.toContain('19 $/mois');
    expect(zh).toContain('每年 $159');
    expect(zh).not.toContain('$59/yr');
    expect(zh).not.toContain('每月 $19');
  });

  it('renders every answer’s text, open or closed', () => {
    // The closed items are collapsed by the UA, not withheld: a reader can find
    // any answer with find-in-page or a print, and a crawler sees all seven.
    for (const item of FAQ) {
      expect(html).toContain(item.answer);
    }
  });
});
