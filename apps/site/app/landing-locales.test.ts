import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { routing } from '~/i18n/routing.js';
import LandingPage from './[locale]/page.js';

/**
 * French and Chinese use the same redesign as English.
 */

vi.stubEnv('NEXT_PUBLIC_HALE_SMS_NUMBER', '+16475551234');

const HTML = Object.fromEntries(
  await Promise.all(
    routing.locales.map(async (locale) => [
      locale,
      renderToStaticMarkup(await LandingPage({ params: Promise.resolve({ locale }) })),
    ]),
  ),
) as Record<(typeof routing.locales)[number], string>;

function rd(html: string): string {
  const found = html.match(/<div class="rd">[\s\S]*$/);
  return found?.[0] ?? '';
}

describe('every locale renders the redesign', () => {
  it.each(routing.locales)('%s has no homepage question chips and no v4 loop', (locale) => {
    const html = HTML[locale];
    expect(html).not.toContain('class="v4-chip');
    expect(html).not.toContain('class="v4-chips"');
    expect(html).not.toContain('hero_chip');
    expect(html).not.toContain('v4-hero-thread');
    expect(html).not.toContain('v4-thread-cap');
    expect(html).not.toContain('Stouffville');
  });

  it('opens on the approved H1 in each language', () => {
    expect(HTML.en).toContain('Your kids’ year,');
    expect(HTML.en).toContain('handled.');
    expect(HTML.en).toContain('Library playgroup');
    expect(rd(HTML.fr)).toContain('L’année de tes enfants,');
    expect(rd(HTML.fr)).toContain('sans casse-tête.');
    expect(rd(HTML.fr)).not.toContain('Your kids’ year,');
    expect(rd(HTML.zh)).toContain('孩子这一年，');
    expect(rd(HTML.zh)).toContain('交给 Hale。');
    expect(rd(HTML.zh)).not.toContain('Your kids’ year,');
    expect(rd(HTML.zh)).not.toContain('已报名');
  });

  it('uses tu inside the French redesign', () => {
    const body = rd(HTML.fr);
    // « Rendez-vous » is the playdate noun, not the vous pronoun.
    const prose = body.replace(/rendez-vous/gi, '');
    expect(prose).not.toMatch(/\bvous\b/i);
    expect(prose).not.toMatch(/\bvos\b/i);
    expect(prose).not.toMatch(/\bvotre\b/i);
    expect(body).toContain('camp');
  });

  it('keeps the FR and ZH hero and sign-up lines on the English promise', () => {
    const fr = rd(HTML.fr);
    expect(fr).toContain('agent d’IA que tu textes');
    expect(fr).toContain('À partir du 1er décembre, il les inscrit avec ton accord.');
    expect(fr).toContain('Plus de choses faites pour toi, toute l’année.');
    expect(fr).toContain('Le maximum de ce que Hale peut faire.');
    expect(fr).toContain('Tu dis oui, et tu paies.');
    expect(fr).toContain('Texte Hale');
    expect(rd(HTML.en)).toContain('More done for you, all year.');
    expect(rd(HTML.en)).toContain('The most Hale can do.');
    expect(rd(HTML.en)).not.toContain('Every kid, caregivers included');
    expect(rd(HTML.en)).not.toContain('For the whole crew');
    const zh = rd(HTML.zh);
    expect(zh).toContain('AI 代理');
    expect(zh).toContain('从 12 月 1 日起，经你同意帮他们报名。');
    expect(zh).toContain('一整年，更多事由它来做。');
    expect(zh).toContain('Hale 能做的，到这里最多。');
    expect(zh).not.toContain('每个孩子，照顾的人也算上');
    expect(zh).toContain('你说可以，然后你来付款。');
    expect(zh).not.toContain('已报名');
  });
});
