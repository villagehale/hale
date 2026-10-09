import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { type Locale, routing } from '~/i18n/routing';
import { FAQ } from '~/lib/faq/index';
import { RedesignFaq } from './faq';
import { RedesignHome } from './home';
import { RedesignPricing } from './pricing';

/**
 * Each marketing FAQ row has a stable English slug, unique on its page and
 * the same in en, fr, and zh. Section ids on the same page stay out of the way.
 */

const HOME_IDS = [
  'does-hale-book-or-register-for-me',
  'is-it-free',
  'do-i-need-an-app',
  'what-about-our-privacy',
] as const;

const PRICING_IDS = [
  'when-do-plus-and-max-open',
  'whats-the-difference-between-plus-and-max',
] as const;

const FAQ_SECTION_IDS = ['main', 'start', 'groups', 'does', 'cost', 'privacy', 'ask'] as const;

function detailsIds(html: string): string[] {
  return [...html.matchAll(/<details\b[^>]*>/g)].map((match) => {
    const id = match[0].match(/\bid="([^"]+)"/)?.[1];
    if (!id) throw new Error(`FAQ row is missing an id: ${match[0]}`);
    return id;
  });
}

function allIds(html: string): string[] {
  return [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1] ?? '');
}

function render(locale: Locale) {
  const props = { locale, smsNumber: '+16475551234', prefill: 'Hey Hale' };
  return {
    home: renderToStaticMarkup(createElement(RedesignHome, props)),
    faq: renderToStaticMarkup(createElement(RedesignFaq, props)),
    pricing: renderToStaticMarkup(createElement(RedesignPricing, props)),
  };
}

describe('FAQ accordion ids', () => {
  it.each(routing.locales)('%s uses the same unique English slug on each page', (locale) => {
    const pages = render(locale);

    expect(detailsIds(pages.home)).toEqual([...HOME_IDS]);
    expect(detailsIds(pages.faq)).toEqual(FAQ.map((item) => item.id));
    expect(detailsIds(pages.pricing)).toEqual([...PRICING_IDS]);

    for (const html of [pages.home, pages.faq, pages.pricing]) {
      const ids = allIds(html);
      expect(ids).toEqual([...new Set(ids)]);
      const rows = html.match(/<details\b[^>]*>/g) ?? [];
      expect(rows.length).toBeGreaterThan(0);
      for (const tag of rows) {
        expect(tag).not.toMatch(/\sopen(?:=|\s|>)/);
        expect(tag).not.toContain('name=');
        expect(tag).toContain('hs-acc');
      }
      expect(html).toContain('<summary>');
      expect(html).toContain('<h3 class="hs-h3">');
      expect(html).toContain('class="v"');
    }

    for (const sectionId of FAQ_SECTION_IDS) {
      expect(FAQ.map((item) => item.id)).not.toContain(sectionId);
    }
  });

  it('keeps Jump to → Getting started pointed at the only id="start"', () => {
    const { faq } = render('en');
    expect(faq.match(/id="start"/g)).toEqual(['id="start"']);
    expect(faq).toContain('href="#start"');
    expect(faq).toContain('id="ask"');
    expect(faq).not.toContain('type="search"');
    expect(faq).toContain('See Plus and Max pricing.');
    expect(faq).toContain('href="/privacy"');
    expect(faq).toContain('mailto:aloha@villagehale.com');
    for (const item of FAQ) {
      if (item.question === 'What happens to our data?' || item.question === 'Is Hale a person?') {
        continue;
      }
      expect(faq).toContain(item.answer);
    }
  });

  it('ships the accordion rules: focus ring, scroll margin, reduced motion, print', () => {
    const css = readFileSync(fileURLToPath(new URL('../../app/redesign.css', import.meta.url)), 'utf8');
    expect(css).toContain('.rd .hs-acc { scroll-margin-top: 96px; }');
    expect(css).toContain('outline: 2px solid var(--navy)');
    expect(css).toContain('border-radius: var(--r-sm)');
    expect(css).toContain('.rd .hs-acc:last-of-type { border-bottom: 1px solid var(--rule); }');
    expect(css).toContain(
      '.rd .hs-acc::details-content, .rd .hs-acc > summary, .rd .hs-acc-ic .v { transition: none; }',
    );
    expect(css).toContain(
      '.rd .hs-acc::details-content { display: contents; block-size: auto; content-visibility: visible; }',
    );
    expect(css.match(/\.rd details\.hs-acc \{ padding: 0/g)).toHaveLength(1);
  });
});
