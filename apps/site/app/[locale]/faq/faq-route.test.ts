import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FAQ } from '~/lib/faq/index.js';
import FaqPage from './page.js';

const messages = (name: string) =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(`../../../messages/${name}.json`, import.meta.url)), 'utf8'),
  ) as {
    Faq: { metaDescription: string };
  };

const html = renderToStaticMarkup(
  await FaqPage({ params: Promise.resolve({ locale: 'en' as const }) }),
);

describe('/faq — canonical product FAQ', () => {
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
      "Straight answers about Hale for parents: it's free with unlimited chat, works for kids 0–18, and never acts without you.",
    );
    expect(messages('fr').Faq.metaDescription).toBe(
      "Des réponses claires sur Hale pour les parents : gratuit, textos illimités, pour les enfants de 0 à 18 ans, et Hale n'agit jamais sans toi.",
    );
    expect(messages('zh').Faq.metaDescription).toBe(
      '给家长的 Hale 常见问题：免费、聊天不限量，适合 0–18 岁的孩子，没有你的同意绝不擅自行动。',
    );
  });

  it('renders every answer’s text, open or closed', () => {
    // The closed items are collapsed by the UA, not withheld: a reader can find
    // any answer with find-in-page or a print, and a crawler sees all seven.
    for (const item of FAQ) {
      expect(html).toContain(item.answer);
    }
  });
});
