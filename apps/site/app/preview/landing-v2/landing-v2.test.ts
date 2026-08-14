import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { F14_LANDING_ENV } from '~/lib/flags/landing.js';
import LandingV2Preview, { metadata } from './page.js';

/**
 * Landing v2 — the candidate homepage at /preview/landing-v2.
 *
 * app/landing-f14.test.ts owns the LIVE page and is untouched by this file. What
 * is pinned here is what v2 adds or must not lose:
 *   · the preview stays out of the index and off the live page,
 *   · every conversion fix and honesty claim v1 shipped survives the redesign,
 *   · the rotating card carries all three grounded exchanges in the DOM, and
 *   · the turtle is back.
 */

const LIVE_NUMBER = '+16475551234';

/**
 * v2 is the flag-on page's replacement, so it is rendered in the flip state: the
 * shared bits it inherits — `siteJsonLd()` above all — branch on
 * NEXT_PUBLIC_F14_LANDING exactly as they do for v1. (The preview route itself
 * reads no flag; it renders v2 unconditionally, so on a deploy with the flag off
 * the graph is the village one. That is inert — the route is noindex — and it is
 * the same graph the live homepage would emit on that deploy.)
 */
function render({ number = LIVE_NUMBER }: { number?: string } = {}): string {
  vi.stubEnv(F14_LANDING_ENV, 'true');
  vi.stubEnv('NEXT_PUBLIC_HALE_SMS_NUMBER', number);
  return renderToStaticMarkup(createElement(LandingV2Preview));
}

function visibleText(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Just the three exchange panels — the rotating card, without the page around it. */
function cardText(html: string): string {
  const start = html.indexOf('class="v2-swap"');
  const end = html.indexOf('class="v2-rail"');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return visibleText(html.slice(start, end));
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('landing v2 — the preview is a preview', () => {
  it('is noindex, nofollow: a second copy of the homepage must never be crawlable', () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });

  it('is absent from the sitemap', async () => {
    const sitemap = (await import('~/app/sitemap.js')).default();
    expect(sitemap.map((entry) => entry.url).some((url) => url.includes('/preview'))).toBe(false);
  });

  it('confines dark mode to v2 — no theme override escapes to :root, html or body', async () => {
    // v2 brings the site its first dark mode, and it arrives as custom
    // properties re-pointed on `.v2-theme`. The invariant that keeps v1 and
    // every subpage light-only is that no prefers-color-scheme: dark rule in
    // globals.css targets anything outside that class. One `:root` in that
    // media query would flip the entire marketing site in the same deploy.
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const postcss = (await import('postcss')).default;
    const css = readFileSync(
      fileURLToPath(new URL('../../globals.css', import.meta.url)),
      'utf8',
    );

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
      expect(selector, `${selector} must be scoped to .v2-theme`).toContain('.v2-theme');
    }
  });

  it('carries the theme class on the page root, where the tokens have to inherit from', () => {
    const main = render().match(/<main[^>]*>/)?.[0] ?? '';
    expect(main).toContain('v2-theme');
  });

  it('leaves the live landing untouched — v2 is a parallel file, not a swap', async () => {
    // The whole point of the preview: with the landing flag on — the state v2 is
    // auditioning to take over — app/page.tsx still serves v1. If this fails, v2
    // has reached villagehale.com/ without a decision being made.
    vi.stubEnv(F14_LANDING_ENV, 'true');
    const page = await import('~/app/page.js');
    const live = renderToStaticMarkup(createElement(page.default));
    expect(live).toContain('Hi, I’m Hale — your family’s quiet chief of staff.');
    expect(live).not.toContain('v2-accent');
    expect(live).not.toContain('v2-swap');
    expect(live).not.toContain('v2-theme');
  });
});

describe('landing v2 — the hero keeps every conversion fix from #453', () => {
  const html = render();

  it('makes "Text me" the sms: deep link and prints the number in the CTA block', () => {
    expect(html).toContain('href="sms:+16475551234?&amp;body=Hi"');
    expect(html).toContain('Text me');
    const cta = html.indexOf('id="start"');
    const number = html.indexOf('+1 (647) 555-1234');
    const gated = html.indexOf('hidden', cta);
    expect(cta).toBeGreaterThan(-1);
    expect(number).toBeGreaterThan(cta);
    expect(number).toBeLessThan(gated);
    expect(html).toContain('>+1 (647) 555-1234</a>');
  });

  it('keeps the sticky header carrying Text Hale, split by where each half works', () => {
    const header = html.match(/<header[\s\S]*?<\/header>/)?.[0] ?? '';
    expect(header).toContain('sticky top-0');
    expect([...header.matchAll(/Text Hale/g)]).toHaveLength(2);
    expect(header).toContain('href="sms:+16475551234?&amp;body=Hi"');
    expect(header).toContain('href="#start"');
  });

  it('opens on the three-bubble teaser with the rest of the script one tap away', () => {
    const bubble = /<span class="sr-only">/g;
    const teaser = html.slice(0, html.indexOf('<details'));
    expect([...teaser.matchAll(bubble)]).toHaveLength(3);
  });

  it('gives the h1 the serif accent, without changing a word of the sentence', () => {
    expect([...html.matchAll(/<h1[\s>]/g)]).toHaveLength(1);
    const h1 = html.match(/<h1[\s\S]*?<\/h1>/)?.[0] ?? '';
    expect(visibleText(h1)).toBe('Hi, I’m Hale — your family’s quiet chief of staff.');
    expect(h1).toContain('class="v2-accent"');
  });
});

describe('landing v2 — the rotating card carries three grounded exchanges', () => {
  const html = render();
  const text = visibleText(html);

  it('renders all three in the DOM, not one at a time', () => {
    // Stacked in one grid cell and crossfaded, so every exchange is readable by a
    // crawler and reachable by the rail even with JavaScript off.
    expect([...html.matchAll(/class="v2-swap"/g)]).toHaveLength(3);
  });

  it('plays the radar exchange verbatim, on the real Halton Hills window', () => {
    // registration-windows-data.ts: halton_hills / rec_program / Fall 2026,
    // residentOpenAt 2026-09-01T07:00-04:00, residentPriorityDays 7.
    expect(text).toContain('Max is 4, Mia is 18 months, L7G 4S8');
    expect(text).toContain(
      'Halton Hills opens fall rec registration Tuesday, Sep 1 at 7 a.m., and as residents you get a 7-day head start before it opens to everyone.',
    );
    // Saying what it has NOT finished is the honesty the product ships; a demo
    // that trimmed it would be selling a Hale that always has the answer.
    expect(text).toContain('Still mapping what’s on near you this weekend');
  });

  it('plays the coaching exchange off the solids playbook, with the skill’s own offer line', () => {
    // coaching-playbooks.ts `solids`: iron-rich foods twice a day at about 6
    // months, then allergens one at a time at home, because waiting does not
    // protect (CPS/Health Canada; LEAP 2015, EAT 2016).
    expect(text).toContain('Around 6 months, and start with iron-rich foods twice a day');
    expect(text).toContain('bring in the common allergens one at a time, at home');
    expect(text).toContain('waiting doesn’t protect');
    // coach-channel-sms.md carries this sentence verbatim as the offer.
    expect(text).toContain('Want the full plan? Reply YES and I’ll send it.');
    // The card must not out-claim the skill: no dose, no diagnosis, no promise.
    // Scoped to the card, because the page elsewhere says — correctly — that Hale
    // does NOT diagnose, and a page-wide ban would read that sentence as a breach.
    const card = cardText(html);
    for (const forbidden of ['guaranteed', 'will fix', 'cure', 'diagnos']) {
      expect(card).not.toContain(forbidden);
    }
    // Positive control for the negative assertions above: the slice really does
    // hold the answer they are scanning, so "absent" means absent, not empty.
    expect(card).toContain('iron-rich foods twice a day');
  });

  it('plays the approval exchange verbatim — a draft, in future tense, awaiting YES', () => {
    expect(text).toContain('max has a bday party sat 2pm at riverdale farm');
    expect(text).toContain(
      'Add Max’s birthday party — Sat, Aug 23 at 2pm, Riverdale Farm? YES to confirm.',
    );
  });

  it('labels the card as the replies Hale is built to send, not a family’s real thread', () => {
    expect(text).toContain('These are the replies I');
    expect(text).toContain('the script I follow and the sourced plans behind it');
    for (const overclaim of ['from a real family', 'real customer', 'screenshot']) {
      expect(text).not.toContain(overclaim);
    }
  });

  it('gives every exchange a rail button, so reduced motion still reaches all three', () => {
    // Auto-rotation is the only thing prefers-reduced-motion switches off. If the
    // rail were decoration rather than buttons, two thirds of the card would be
    // unreachable for those readers.
    expect([...html.matchAll(/class="v2-rail"/g)]).toHaveLength(3);
    expect([...html.matchAll(/<button/g)].length).toBeGreaterThanOrEqual(3);
  });
});

describe('landing v2 — the turtle is back', () => {
  const html = render();

  it('waves beside the conversation and cheers at the close, decoratively', () => {
    const turtles = [...html.matchAll(/hale-turtle-(wave|celebrate)/g)].map((m) => m[1]);
    expect(turtles).toContain('wave');
    expect(turtles).toContain('celebrate');
    // Decorative art in a page whose meaning is entirely in its text: named as
    // such, so a screen reader is not made to describe a cartoon.
    for (const img of html.match(/<img[^>]*hale-turtle[^>]*>/g) ?? []) {
      expect(img).toContain('alt=""');
      expect(img).toContain('aria-hidden="true"');
    }
  });

  it('reveals the art with the mask wipe rather than a bare fade', () => {
    expect(html).toContain('v2-mask');
  });
});

describe('landing v2 — nothing v1 promised is lost', () => {
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
      'Then you just talk to me',
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
    expect(text).toContain('ask me in the thread');
    expect(text).toContain('sign in with your phone number');
    expect(text).toContain('doctor');
  });

  it('keeps the privacy register and the JSON-LD graph', () => {
    expect(text).toContain('stays in Canada');
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

describe('landing v2 — number not provisioned', () => {
  const html = render({ number: '' });

  it('never renders a dead sms: link, and falls back to email', () => {
    expect(html).not.toContain('sms:');
    expect(html).not.toContain('Text me');
    expect(html).not.toContain('Text Hale');
    expect(html).not.toContain('647');
    expect(html).toContain('href="mailto:aloha@villagehale.com"');
    expect(html).toContain('The number’s coming');
  });

  it('still shows the rotating card — the proof does not depend on the number', () => {
    expect([...html.matchAll(/class="v2-swap"/g)]).toHaveLength(3);
  });
});
