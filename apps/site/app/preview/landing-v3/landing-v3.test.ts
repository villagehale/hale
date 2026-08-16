import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { F14_LANDING_ENV } from '~/lib/flags/landing.js';
import LandingV3Preview, { metadata } from './page.js';

/**
 * Landing v3 — the conversational homepage at /preview/landing-v3.
 *
 * app/landing-f14.test.ts owns the LIVE page and is untouched by this file. What
 * is pinned here is what v3 stakes itself on:
 *   · the bubble types Hale's REAL greeting, drift-checked against the worker's
 *     own intake copy rather than against a constant next door,
 *   · the four reply chips are real buttons carrying real parent asks,
 *   · the number's digits never reach the page — with a positive control, so the
 *     absence assertion cannot pass on an empty render,
 *   · the header carries the flat turtle mark and no mascot art appears, and
 *   · every claim v1 shipped survives.
 */

const LIVE_NUMBER = '+16475551234';

/**
 * v3 is the flag-on page's replacement, so it is rendered in the flip state: the
 * shared bits it inherits — `siteJsonLd()` above all — branch on
 * NEXT_PUBLIC_F14_LANDING exactly as the live page does.
 */
function render({ number = LIVE_NUMBER }: { number?: string } = {}): string {
  vi.stubEnv(F14_LANDING_ENV, 'true');
  vi.stubEnv('NEXT_PUBLIC_HALE_SMS_NUMBER', number);
  return renderToStaticMarkup(createElement(LandingV3Preview));
}

function visibleText(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Curly punctuation is the site's display layer; the worker sends plain ASCII. */
function plain(text: string): string {
  return text.replace(/[’‘]/g, "'").replace(/[—–]/g, '-').replace(/\s+/g, ' ').trim();
}

/**
 * `greeting(null)` as the worker would send it, read out of the source rather
 * than restated here — a copy of the copy would drift in step with the page and
 * pin nothing.
 *
 * Structural, not textual: the venue-less greeting is the function's LAST return
 * (the fall-through past `if (venue)`), and the ask it interpolates is the shared
 * COLD_START_ASK constant. Matching on the words instead would have re-encoded
 * the very string under test — and did, on the first pass: an anchor on "Hi, I'm
 * Hale - an AI" pulled the QR-venue branch and compared the page against a
 * message it never shows.
 */
function workerGreeting(): string {
  const source = readFileSync(
    fileURLToPath(new URL('../../../../web/lib/channel/intake/copy.ts', import.meta.url)),
    'utf8',
  );
  const fn = /export function greeting\([^)]*\): string \{([\s\S]*?)\n\}/.exec(source);
  const returns = [...(fn?.[1] ?? '').matchAll(/return `([^`]*)`;/g)].map((m) => m[1]);
  const ask = /export const COLD_START_ASK =\s*"([^"]+)"/.exec(source);
  const body = returns.at(-1);
  if (!body || !ask?.[1]) throw new Error('intake/copy.ts no longer exposes greeting(null)');
  // Two branches today — venue, then the cold start. If that ever collapses to
  // one, this is reading the wrong message and must be revisited.
  expect(returns).toHaveLength(2);
  return body.replace('${COLD_START_ASK}', ask[1]);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('landing v3 — the preview is a preview', () => {
  it('is noindex, nofollow: a second copy of the homepage must never be crawlable', () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });

  it('is absent from the sitemap', async () => {
    const sitemap = (await import('~/app/sitemap.js')).default();
    expect(sitemap.map((entry) => entry.url).some((url) => url.includes('/preview'))).toBe(false);
  });

  it('confines dark mode to the preview — no theme override escapes to :root', async () => {
    // Dark mode arrives as custom properties re-pointed on a wrapper class. The
    // invariant that keeps the live page and every subpage light-only is that no
    // prefers-color-scheme: dark rule in globals.css targets anything outside a
    // preview theme class. One `:root` in that media query would flip the whole
    // marketing site in the same deploy.
    const postcss = (await import('postcss')).default;
    const css = readFileSync(fileURLToPath(new URL('../../globals.css', import.meta.url)), 'utf8');

    const selectors: string[] = [];
    postcss.parse(css).walkAtRules('media', (rule) => {
      if (!rule.params.includes('prefers-color-scheme')) return;
      if (!rule.params.includes('dark')) return;
      rule.walkRules((inner) => {
        selectors.push(inner.selector.replace(/\s+/g, ' ').trim());
      });
    });

    // Positive control: the dark block exists at all, so the assertion below is
    // scanning something rather than passing on an empty list.
    expect(selectors.length).toBeGreaterThan(0);
    for (const selector of selectors) {
      expect(selector, `${selector} must be scoped to a preview theme`).toContain('-theme');
    }
  });

  it('carries the theme class on the page root, where the tokens have to inherit from', () => {
    expect(render().match(/<main[^>]*>/)?.[0] ?? '').toContain('v3-theme');
  });

  it('leaves the live landing untouched — v3 is a parallel file, not a swap', async () => {
    vi.stubEnv(F14_LANDING_ENV, 'true');
    const live = renderToStaticMarkup(createElement((await import('~/app/page.js')).default));
    expect(live).toContain('Hi, I’m Hale — your family’s quiet chief of staff.');
    expect(live).not.toContain('v3-theme');
    expect(live).not.toContain('v3-chip');
  });
});

describe('landing v3 — the hero is the real conversation', () => {
  const html = render();

  it('types the greeting the worker actually sends, word for word', () => {
    // The drift gate. The bubble's sizer span holds the whole message in the DOM
    // (it is what a crawler and a reader with JavaScript off get), so it is the
    // copy this compares — and it must equal intake/copy.ts once the site's
    // curly quotes and em dashes are normalised back to the wire's ASCII.
    const sizer = /<span class="v3-bubble-sizer" aria-hidden="true">([\s\S]*?)<\/span>/.exec(html);
    expect(sizer?.[1]).toBeTruthy();
    expect(plain(visibleText(sizer?.[1] ?? ''))).toBe(plain(workerGreeting()));
  });

  it('labels the bubble as Hale’s real opening message, not a dramatisation', () => {
    const text = visibleText(html);
    expect(text).toContain('Hale texts like this — this is its real opening message');
    for (const overclaim of ['from a real family', 'real customer', 'screenshot']) {
      expect(text).not.toContain(overclaim);
    }
  });

  it('gives a screen reader the whole message at once, and hides the animated copy', () => {
    // A paragraph announced one character at a time is unusable, so the sr-only
    // copy is the accessible one and both painted copies are aria-hidden.
    expect(html).toContain('<span class="sr-only">Hale: Hi, I’m Hale —');
    expect(html).toContain('<span class="v3-bubble-sizer" aria-hidden="true">');
  });

  it('renders the four reply chips as real buttons carrying the parent’s own words', () => {
    const chips = [...html.matchAll(/<button type="button" class="v3-chip"[^>]*>([^<]+)<\/button>/g)]
      .map((m) => m[1]);
    expect(chips).toEqual([
      'When should Mia start solids?',
      'Watch registration dates for us',
      'What can we do Saturday morning?',
      'Is a checkup due?',
    ]);
    // Single-select, and announced as pressed state rather than by colour alone.
    expect([...html.matchAll(/aria-pressed="false"/g)]).toHaveLength(4);
  });

  it('opens on the bare greeting as the draft, so the CTA works before any chip', () => {
    expect(html).toContain('Your first text');
    expect(html).toContain('<span class="v3-draft-body">Hi</span>');
    expect(html).toContain('href="sms:+16475551234?&amp;body=Hi"');
  });

  it('keeps the h1 compact and gives it the serif accent', () => {
    expect([...html.matchAll(/<h1[\s>]/g)]).toHaveLength(1);
    const h1 = html.match(/<h1[\s\S]*?<\/h1>/)?.[0] ?? '';
    expect(visibleText(h1)).toBe('Hale is a number you text — your family’s quiet chief of staff.');
    expect(h1).toContain('class="v3-accent"');
  });

  it('is a single centred column — no split hero, no phone mockup', () => {
    // The whole point of v3. A grid-cols-2 hero or a device frame would be the
    // layout the founder rejected, reintroduced.
    const hero = html.slice(html.indexOf('<h1'), html.indexOf('What I watch'));
    expect(hero).toContain('v3-thread');
    expect(hero).not.toMatch(/lg:grid-cols-\[/);
    expect(hero).not.toContain('grid-cols-2');
  });
});

describe('landing v3 — the number is reachable and never readable', () => {
  const html = render();
  const text = visibleText(html);

  it('never prints the digits, in any grouping', () => {
    for (const rendering of ['+1 (647) 555-1234', '6475551234', '647-555-1234', '(647)']) {
      expect(text, `${rendering} must not be visible`).not.toContain(rendering);
    }
    // Positive control for the four assertions above: the number IS on the page,
    // invisibly, so "absent" means withheld rather than never rendered at all.
    expect(html).toContain('href="sms:+16475551234?&amp;body=Hi"');
  });

  it('offers the clipboard as the laptop path instead of the digits', () => {
    expect(text).toContain('Copy my number');
    expect(html).not.toContain('displaySmsNumber');
  });
});

describe('landing v3 — the brand tile, the shore, and nothing else', () => {
  const html = render();

  it('puts the logo tile in the header beside the wordmark', () => {
    const header = html.match(/<header[\s\S]*?<\/header>/)?.[0] ?? '';
    expect(header).toContain('hale-logo');
    expect(header).toMatch(/alt=""/);
    expect(header).toContain('>Hale</span>');
  });

  /**
   * The honesty pin, widened rather than dropped. The live page pins "no <img>
   * at all", which was the right rule for a page whose only picture would have
   * been a fake screenshot. v3 carries two kinds of image — the brand tile and
   * one shore panel — and the rule that has to survive is the one underneath
   * it: no image on this page carries an argument. Every one is decorative, from
   * the known asset set, and none of them is anywhere near the conversation.
   */
  it('allows only decorative images, only from the brand set', () => {
    const imgs = html.match(/<img[^>]*>/g) ?? [];
    // Positive control: there ARE images, so the per-image assertions below are
    // checking something rather than iterating an empty list.
    expect(imgs.length).toBeGreaterThanOrEqual(3);
    for (const img of imgs) {
      expect(img, 'every image is decorative').toContain('alt=""');
      expect(img, 'every image is hidden from assistive tech').toContain('aria-hidden="true"');
      expect(img, `unexpected asset: ${img.slice(0, 90)}`).toMatch(
        /hale-logo|hale-shore-night/,
      );
    }
  });

  it('keeps the conversation image-free — a message, never a picture of one', () => {
    const hero = html.slice(html.indexOf('<h1'), html.indexOf('What I watch'));
    expect(hero).not.toContain('<img');
    // Positive control: the slice really is the hero.
    expect(hero).toContain('v3-bubble');
  });

  it('closes on the shore — one panel, once — and no mascot art anywhere', () => {
    // Counted as <img> elements, not as filename occurrences: next/image emits
    // the same asset name once per srcset candidate.
    const shorePanels = (html.match(/<img[^>]*>/g) ?? []).filter((img) =>
      img.includes('hale-shore-night'),
    );
    expect(shorePanels).toHaveLength(1);
    for (const mascot of ['hale-turtle', 'village-illustration', 'diamondhead', 'shore-ultrawide']) {
      expect(html, `${mascot} must not appear`).not.toContain(mascot);
    }
  });

  it('says the name out loud in the footer', () => {
    // The brand line every subpage carries (site-footer.tsx) and the live
    // landing dropped. Hale is Hawaiian for home; the mark is a honu.
    const footer = html.match(/<footer[\s\S]*?<\/footer>/)?.[0] ?? '';
    expect(visibleText(footer)).toContain('Hale /HAH-leh/ — Hawaiian for home.');
  });
});

describe('landing v3 — nothing v1 promised is lost', () => {
  const html = render();
  const text = visibleText(html);

  it('still names all fifteen seeded municipalities', () => {
    for (const city of [
      'Toronto',
      'Mississauga',
      'Brampton',
      'Markham',
      'Vaughan',
      'Richmond Hill',
      'Oakville',
      'Burlington',
      'Halton Hills',
      'Caledon',
      'Ajax',
      'Pickering',
      'Whitby',
      'Oshawa',
      'Aurora',
    ]) {
      expect(text).toContain(city);
    }
    expect(text).toContain('15 municipalities');
    expect([...html.matchAll(/class="pill pill-apricot"/g)]).toHaveLength(15);
  });

  it('keeps the section order and every band of the Surfaces Plan', () => {
    const order = [
      'quiet chief of staff',
      'What I watch',
      'How I work',
      'When you ask me something',
      'Your helpers',
      'the Canadian way',
      'Founding families',
    ].map((marker) => text.indexOf(marker));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('keeps the ladder, the receipts promise and the medical boundary', () => {
    expect(text).toContain('I suggest');
    expect(text).toContain('I prepare');
    expect(text).toContain('with your ok, I handle it');
    expect(text.toLowerCase()).toContain('receipts');
    expect(text).toContain('doctor');
  });

  it('keeps the privacy register, the CASL line and the JSON-LD graph', () => {
    expect(text).toContain('stays in Canada');
    expect(text).toContain('You send it; I never text first');
    expect(text).toContain('reply STOP any time');
    expect(html).toContain('href="/privacy"');
    expect(html).toContain('application/ld+json');
    expect(html).toContain('A number your family texts');
  });

  it('still has no signup funnel and no invented urgency', () => {
    expect(html).not.toContain('/sign-up');
    expect(html).not.toContain('/onboarding');
    for (const label of ['Get started', 'Sign up', 'Join free', 'Create an account']) {
      expect(html).not.toContain(label);
    }
    for (const pressure of ['Only', 'spots left', 'Hurry', 'ends soon', 'Limited time']) {
      expect(text).not.toContain(pressure);
    }
  });

  it('omits the impact band while the counts are not real', () => {
    for (const label of ['families covered', 'registrations caught', 'weeks planned']) {
      expect(text).not.toContain(label);
    }
  });
});

describe('landing v3 — number not provisioned', () => {
  const html = render({ number: '' });

  it('never renders a dead sms: link, and falls back to email', () => {
    expect(html).not.toContain('sms:');
    expect(html).not.toContain('Text me');
    expect(html).not.toContain('Text Hale');
    expect(html).not.toContain('647');
    expect(html).toContain('href="mailto:aloha@villagehale.com"');
    expect(html).toContain('The number’s coming');
  });

  it('still types the greeting and offers the chips — neither needs the number', () => {
    expect(html).toContain('v3-bubble-sizer');
    expect([...html.matchAll(/class="v3-chip"/g)]).toHaveLength(4);
  });
});
