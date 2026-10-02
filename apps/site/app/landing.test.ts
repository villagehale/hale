import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { impactNumbers } from '~/lib/landing/impact.js';
import { MUNICIPALITIES } from '~/lib/site/municipalities.js';
import LandingPage from './[locale]/page.js';

/**
 * villagehale.com — a short hero on the shore.
 *
 * The page is one headline, one subhead, one Text Hale door, and a phone
 * thread. Below that: four product lines, the live pricing cards, a short
 * FAQ, and the shared footer. No city in the hero, no booking claim in a
 * bubble, no price, no signup funnel.
 */

const LIVE_NUMBER = '+16475551234';

async function renderLanding(number: string): Promise<string> {
  vi.stubEnv('NEXT_PUBLIC_HALE_SMS_NUMBER', number);
  const html = renderToStaticMarkup(
    await LandingPage({ params: Promise.resolve({ locale: 'en' as const }) }),
  );
  vi.unstubAllEnvs();
  return html;
}

const LIVE_HTML = await renderLanding(LIVE_NUMBER);
const EMPTY_HTML = await renderLanding('');

function render({ number = LIVE_NUMBER }: { number?: string } = {}): string {
  return number === '' ? EMPTY_HTML : LIVE_HTML;
}

function visibleText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function hero(html: string): string {
  return html.match(/<section class="v4-hero v4-hero-top"[\s\S]*?<\/section>/)?.[0] ?? '';
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('landing — the hero', () => {
  const html = render();
  const heroHtml = hero(html);

  it('opens on a warm ground, with one serif headline and one subhead', () => {
    expect(html).toContain('class="v4-hero v4-hero-top"');
    expect(html).not.toContain('hale-shore-hero');
    expect(html).not.toContain('v4-hero-art');
    expect([...html.matchAll(/<h1[\s>]/g)]).toHaveLength(1);
    const h1 = html.match(/<h1[\s\S]*?<\/h1>/)?.[0] ?? '';
    expect(h1).toContain('v4-display');
    expect(h1).toContain('class="v4-accent"');
    expect(visibleText(h1)).toBe('Weekends, sorted by text.');
    expect(visibleText(heroHtml)).toContain('What’s on near you, this Saturday.');
    expect(visibleText(heroHtml)).not.toContain('!');
  });

  it('keeps the hero to one door, labelled Text Hale, wired to the chooser', () => {
    expect(heroHtml).toContain('data-cta-placement="hero"');
    expect(heroHtml).toContain('href="/text"');
    expect(heroHtml).toContain('data-cta="cta_message_click"');
    expect([...heroHtml.matchAll(/Text Hale/g)]).toHaveLength(1);
    expect(html).not.toContain('Message Hale');
    expect(html).not.toContain('data-cta-placement="closing"');
  });

  it('puts a phone thread in the hero: a short ask, a reply, and Hale typing', () => {
    expect(heroHtml).toContain('v4-phone');
    expect(heroHtml).toContain('v4-hero-thread');
    expect([...heroHtml.matchAll(/class="v4-bubble v4-bubble-out"/g)]).toHaveLength(1);
    expect([...heroHtml.matchAll(/class="v4-bubble v4-bubble-in"/g)]).toHaveLength(1);
    expect(heroHtml).toContain('class="v4-typing"');
    expect(heroHtml).toContain('Hale is typing');
    const text = visibleText(heroHtml);
    expect(text).toContain('Swim this Saturday, near us.');
    expect(text).toContain('I’ll watch if one fills up.');
  });

  it('names no city and makes no booking claim inside the hero', () => {
    const text = visibleText(heroHtml);
    for (const town of MUNICIPALITIES) {
      expect(text, town).not.toMatch(new RegExp(`\\b${town}\\b`));
    }
    for (const banned of [
      'Georgetown',
      'STOP',
      'assistant',
      'I register',
      'I’ll register',
      'I book',
      'signed you up',
      'registered',
    ]) {
      expect(text, banned).not.toContain(banned);
    }
    expect(text).not.toMatch(/\$\d/);
  });

  it('shows the iMessage trust line under the hero door, with the privacy link', () => {
    expect(heroHtml).toContain('class="v4-hero-terms"');
    expect(visibleText(heroHtml)).toContain(
      'You text first, on iMessage. Your data stays in Canada — privacy policy',
    );
    expect(heroHtml).toContain('href="/privacy"');
  });
});

describe('landing — the number is reachable and never readable', () => {
  const html = render();
  const text = visibleText(html);

  it('never prints the digits', () => {
    for (const rendering of ['+1 (647) 555-1234', '6475551234', '647-555-1234', '(647) 555-1234']) {
      expect(text, rendering).not.toContain(rendering);
    }
    // The pricing card's free door is an sms: link. The digits live in the href.
    expect(html).toContain(`href="sms:${LIVE_NUMBER}`);
  });

  it('opens no composer from the hero — the chooser owns that door', () => {
    const heroHtml = hero(html);
    expect(heroHtml).not.toContain('sms:');
    expect([...html.matchAll(/data-cta="copy_number_click"/g)]).toHaveLength(0);
    expect(text).not.toContain('Copy number');
  });
});

describe('landing — the brand tile', () => {
  const html = render();

  it('allows only the decorative logo, not a place photograph', () => {
    const imgs = html.match(/<img[^>]*>/g) ?? [];
    // Header logo and footer logo. The hero is a token gradient.
    expect(imgs).toHaveLength(2);
    for (const img of imgs) {
      expect(img).toContain('alt=""');
      expect(img).toContain('aria-hidden="true"');
      expect(img).toContain('hale-logo');
    }
    expect(html).not.toContain('hale-shore');
    expect(html).not.toContain('hale-turtle');
  });

  it('keeps every drawing decorative', () => {
    const svgs = html.match(/<svg[^>]*>/g) ?? [];
    expect(svgs.length).toBeGreaterThanOrEqual(4);
    for (const svg of svgs) {
      expect(svg, svg.slice(0, 80)).toContain('aria-hidden="true"');
    }
    expect([...html.matchAll(/<span class="sr-only" translate="no">Hale<\/span>/g)]).toHaveLength(
      2,
    );
  });

  it('says the name out loud in the shared footer, with the theme switch', () => {
    const footer = html.match(/<footer[\s\S]*?<\/footer>/)?.[0] ?? '';
    expect(visibleText(footer)).toContain('Hale /HAH-leh/ — Hawaiian for home.');
    expect(footer).toContain('class="v4-switch"');
  });
});

describe('landing — no signup funnel', () => {
  const html = render();

  it('has no web signup, and Sign in only in the chrome', () => {
    expect(html).not.toContain('/sign-up');
    expect(html).not.toContain('/onboarding');
    for (const label of ['Get started', 'Sign up', 'Join free', 'Create an account']) {
      expect(html).not.toContain(label);
    }
    const chrome =
      (html.match(/<header[\s\S]*?<\/header>/)?.[0] ?? '') +
      (html.match(/<footer[\s\S]*?<\/footer>/)?.[0] ?? '');
    expect(chrome).toContain('/sign-in');
    const body = html
      .replace(/<header[\s\S]*?<\/header>/, '')
      .replace(/<footer[\s\S]*?<\/footer>/, '');
    expect(body).not.toContain('/sign-in');
  });
});

describe('landing — the short page under the hero', () => {
  const html = render();
  const text = visibleText(html);

  it('keeps four product lines, then pricing, then a short FAQ', () => {
    const order = [
      'Weekends, sorted by text.',
      'Age, place, and a spot.',
      'One line from your inbox.',
      'One question, then the next find.',
      'Your family, one thread.',
      'Free, with unlimited chat.',
      'Questions',
    ].map((marker) => text.indexOf(marker));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(text).toContain('Connect Gmail or Google Calendar');
    expect(text).toContain('What you say shapes what I look for next.');
    expect(text).toContain('Coming soon');
    expect([...html.matchAll(/Coming soon/g)]).toHaveLength(2);
    expect(text).not.toContain('There is no price');
    const faq = html.match(/<section class="shell v4-faq"[\s\S]*?<\/section>/)?.[0] ?? '';
    const pricing = html.match(/<section id="pricing"[\s\S]*?<\/section>/)?.[0] ?? '';
    expect(visibleText(faq)).not.toContain('Canada');
    expect(visibleText(pricing)).not.toContain('Canada');
    expect(visibleText(hero(html))).toContain('Your data stays in Canada');
    expect(visibleText(html.match(/<footer[\s\S]*?<\/footer>/)?.[0] ?? '')).toContain(
      'Your data stays in Canada',
    );
    expect(html).toContain('href="/faq"');
    expect(text).not.toMatch(/\$\d/);
    expect(text).not.toContain('Buy');
  });

  it('does not bring the old long page back', () => {
    expect(html).not.toContain('class="v4-chip');
    expect(html).not.toContain('v4-contrast');
    expect(html).not.toContain('v4-coverage');
    expect(text).not.toContain('Texting Hale looks like this');
    expect(text).not.toContain('Without me');
    expect(text).not.toContain('Three texts');
    expect(text).not.toContain('7:02');
    for (const town of ['Stouffville', 'Halton Hills', 'East Gwillimbury']) {
      expect(text, town).not.toContain(town);
    }
  });
});

describe('landing — structured data and honesty', () => {
  it('describes the page a visitor sees, and invents no metrics', () => {
    const html = render();
    expect(html).toContain('application/ld+json');
    expect(html).toContain('Weekends, sorted by text');
    expect(html).toContain('A planner for your kids’ year');
    expect(html).not.toContain('A number your family texts');
    expect(impactNumbers()).toBeNull();
    expect(visibleText(html)).not.toContain('families covered');
  });
});

describe('landing — number not provisioned', () => {
  const html = render({ number: '' });

  it('degrades the doors to email and withholds the iMessage line', () => {
    expect(html).not.toContain('sms:');
    expect(html).not.toContain('data-cta="cta_message_click"');
    expect(html).not.toContain('Text Hale');
    expect(html).toContain('href="mailto:aloha@villagehale.com"');
    expect(html).not.toContain('class="v4-hero-terms"');
    expect(html).toContain('v4-hero-thread');
    expect(html).toContain('Hale is typing');
  });
});

describe('landing — motion and focus', () => {
  const css = readFileSync(fileURLToPath(new URL('./globals.css', import.meta.url)), 'utf8');

  it('freezes the typing dots under reduced motion and keeps a focus ring on the door', () => {
    expect(css).toContain('@keyframes v4-type');
    const reduce = css.slice(css.lastIndexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduce).toContain('.v4-typing span[aria-hidden=\'true\'] { animation: none; opacity: 1; }');
    expect(css).toContain(
      'box-shadow: 0 0 0 3px var(--color-linen), 0 0 0 5px var(--color-apricot-deep)',
    );
    expect(css).toContain('mask-image: linear-gradient(to bottom, #000 0, #000 calc(100% - 3.25rem), transparent 100%)');
  });

  it('clears WCAG AA for the headline, the trust line, and the nav on the warm ground', () => {
    const rel = (channel: number) => {
      const c = channel / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    const lum = (rgb: number[]) => 0.2126 * rel(rgb[0]) + 0.7152 * rel(rgb[1]) + 0.0722 * rel(rgb[2]);
    const ratio = (fg: number[], bg: number[]) => {
      const hi = Math.max(lum(fg), lum(bg));
      const lo = Math.min(lum(fg), lum(bg));
      return (hi + 0.05) / (lo + 0.05);
    };
    const blend = (fg: number[], alpha: number, bg: number[]) =>
      fg.map((channel, i) => channel * alpha + bg[i] * (1 - alpha));
    const navy = [23, 41, 74];
    const creamInk = [247, 244, 236];
    const lightGrounds = [
      [253, 252, 250],
      [247, 244, 236],
      [254, 240, 199],
    ];
    const darkGround = [12, 26, 54];
    const navOpacity = Number(css.match(/\.v4-navlink \{[\s\S]*?opacity: ([0-9.]+)/)?.[1]);
    expect(navOpacity).toBeGreaterThan(0);
    for (const ground of lightGrounds) {
      expect(ratio(navy, ground)).toBeGreaterThanOrEqual(3);
      expect(ratio(blend(navy, 1, ground), ground)).toBeGreaterThanOrEqual(4.5);
      expect(ratio(blend(navy, navOpacity, ground), ground)).toBeGreaterThanOrEqual(4.5);
    }
    expect(ratio(creamInk, darkGround)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(blend(creamInk, navOpacity, darkGround), darkGround)).toBeGreaterThanOrEqual(4.5);
  });
});
