import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CONTACT_CARD_PATH } from '~/lib/contact-card.js';
import { TextEntry } from './text-entry.js';

/**
 * The /text entry surface (VIL-240 · M5) — the page a QR card at an EarlyON
 * drop-in opens. Two states, both of which must be honest:
 *
 *   number live   → "Text me" deep-links into the composer, and the number +
 *                   a QR of the same sms: URI cover desktop, where sms: is dead.
 *   number unset  → no sms: anywhere on the page, email is the only path, and
 *                   the page says so plainly. (Today's reality.)
 *
 * Rendered to static markup — TextEntry is a pure server component.
 */

const LIVE_NUMBER = '+16475551234';

const liveHtml = renderToStaticMarkup(
  createElement(TextEntry, { source: 'earlyon-richmondhill', smsNumber: LIVE_NUMBER }),
);
const liveNoSourceHtml = renderToStaticMarkup(
  createElement(TextEntry, { source: null, smsNumber: LIVE_NUMBER }),
);
const unsetHtml = renderToStaticMarkup(
  createElement(TextEntry, { source: 'earlyon-richmondhill', smsNumber: '' }),
);

/** The QR's single path — the module grid, drawn inline. Read through the QR's
 * OWN <svg> rather than off the first <path> on the page: since the wordmark
 * became drawn art (components/wordmark.tsx) the first path is the brand mark, so
 * the loose read compared two identical wordmarks and called them a QR. */
function qrPath(html: string): string {
  const svg = /<svg[^>]*QR code[\s\S]*?<\/svg>/.exec(html)?.[0] ?? '';
  return /<path d="([^"]+)"/.exec(svg)?.[1] ?? '';
}

describe('TextEntry (persona copy)', () => {
  it('leads with the locked recut headline and lede', () => {
    for (const html of [liveHtml, unsetHtml]) {
      expect(html).toContain('Change the names to yours and send.');
      expect(html).toContain('I text back the rec dates for that postal. No app.');
    }
  });

  it('names only watched things that exist — no school paperwork Hale cannot see', () => {
    // Same bar the landing holds (app/landing.test.ts): the health timeline and the
    // weather read are real; there is no school-paperwork ingestion in the product.
    for (const html of [liveHtml, unsetHtml]) {
      expect(html).not.toContain('school paperwork');
    }
  });

  it('has exactly one h1', () => {
    expect([...liveHtml.matchAll(/<h1[\s>]/g)]).toHaveLength(1);
    expect([...unsetHtml.matchAll(/<h1[\s>]/g)]).toHaveLength(1);
  });

  it('is a dead end for the funnel — no sign-in, no onboarding, no account ask', () => {
    for (const html of [liveHtml, unsetHtml]) {
      expect(html).not.toContain('/sign-in');
      expect(html).not.toContain('/onboarding');
      expect(html).not.toContain('<form');
      expect(html).not.toContain('<input');
    }
  });
});

describe('TextEntry (number live)', () => {
  it('makes "Text me" an sms: deep link carrying the pre-filled body and the venue token', () => {
    // React escapes the `&` of the cross-platform `?&body=` form into `&amp;`.
    expect(liveHtml).toContain(
      'href="sms:+16475551234?&amp;body=Maya%20is%204%2C%20Theo%20is%2018%20months%2C%20L3R%20(via%20earlyon-richmondhill)"',
    );
    expect(liveHtml).toContain('Text me');
  });

  it('pre-fills the locked intake sample when no venue sent them', () => {
    expect(liveNoSourceHtml).toContain(
      'href="sms:+16475551234?&amp;body=Maya%20is%204%2C%20Theo%20is%2018%20months%2C%20L3R"',
    );
  });

  it('never prints the digits — a copy chip stands in for the readable number', () => {
    // Positive controls so the absences cannot pass vacuously: the composer link
    // and the copy chip are both present…
    expect(liveHtml).toContain('sms:+16475551234');
    // "Copy my number" until 2026-08-20. The chip is the reader's action, not
    // Hale's offer, and one label now serves both call sites — the sentence-case
    // variant this page used is gone with the lowercase one the landing used.
    expect(liveHtml).toContain('Copy number');
    // …and the number never renders as text (the founder rule: reachable, never
    // displayed).
    expect(liveHtml).not.toContain('+1 (647) 555-1234');
    expect(liveHtml).not.toContain('(647) 555-1234');
  });

  it('offers the contact card as the secondary action under the CTA', () => {
    // Saved once, every later Hale text arrives with the turtle and a name on it
    // rather than as an unknown number. Secondary on purpose: texting is the job.
    expect(liveHtml).toContain(`href="${CONTACT_CARD_PATH}"`);
    expect(liveHtml).toContain('Save Hale to your contacts');
    const anchor = new RegExp(`<a[^>]*href="${CONTACT_CARD_PATH}"[^>]*>`).exec(liveHtml)?.[0] ?? '';
    expect(anchor).toContain('btn-secondary');
    // The primary CTA keeps its weight — one btn-primary, and it is the composer.
    expect([...liveHtml.matchAll(/btn-primary/g)]).toHaveLength(1);
  });

  it('renders a scannable QR of the same sms: URI — the desktop path, where sms: links are dead', () => {
    expect(liveHtml).toContain('aria-label="QR code — scan to text Hale"');
    // A real module grid, not a placeholder box: one path move per dark module.
    const modules = [...qrPath(liveHtml).matchAll(/M/g)].length;
    expect(modules).toBeGreaterThan(50);
    // Drawn inline from the URI, not fetched — no third-party chart/image endpoint.
    expect(liveHtml).not.toContain('<img');
  });

  it('encodes the actual link — a different venue produces a different QR', () => {
    expect(qrPath(liveHtml)).not.toBe(qrPath(liveNoSourceHtml));
  });

  it('draws the code on its own light plate, never in theme colours', () => {
    // A QR is not decoration. Drawn in var(--color-spruce) it followed the site
    // theme, and dark mode inverted it to cream modules on navy — a code many
    // scanners refuse. Dark-on-light, whatever the page is doing around it.
    const svg = /<svg[^>]*QR code[\s\S]*?<\/svg>/.exec(liveHtml)?.[0] ?? '';
    expect(svg).toContain('fill="#ffffff"');
    expect(svg).toContain('fill="#17294a"');
    expect(svg, 'a themed fill would invert the code in dark').not.toContain('var(--');
  });

  it('discloses the attribution token instead of smuggling it', () => {
    expect(liveHtml).toContain('(via earlyon-richmondhill)');
    expect(liveNoSourceHtml).not.toContain('(via');
  });
});

describe('TextEntry (the other two locales)', () => {
  it('offers the contact card in French and Chinese too', () => {
    // A key missing from fr.json/zh.json renders as the key path rather than
    // failing the build, so the translated labels are pinned here.
    const fr = renderToStaticMarkup(
      createElement(TextEntry, { source: null, smsNumber: LIVE_NUMBER, locale: 'fr' }),
    );
    const zh = renderToStaticMarkup(
      createElement(TextEntry, { source: null, smsNumber: LIVE_NUMBER, locale: 'zh' }),
    );
    expect(fr).toContain('Enregistrer Hale dans vos contacts');
    expect(zh).toContain('把 Hale 存入通讯录');
    for (const html of [fr, zh]) expect(html).not.toContain('Text.saveContact');
  });
});

describe('TextEntry (number not provisioned — today)', () => {
  it('offers email only, and never a broken sms: link', () => {
    expect(unsetHtml).not.toContain('sms:');
    expect(unsetHtml).toContain('href="mailto:aloha@villagehale.com"');
    expect(unsetHtml).toContain('aloha@villagehale.com');
  });

  it('never leaves mailto as the only path — the address is copyable in place', () => {
    // A bare mailto silently no-ops on devices without a mail handler (most
    // desktops), so the CTA must ship a copy affordance alongside it.
    expect(unsetHtml).toContain('Copy aloha@villagehale.com');
  });

  it('says plainly that the number is not live and the page is unannounced', () => {
    expect(unsetHtml).toContain('The number’s coming — this page isn’t announced yet.');
  });

  it('renders no QR and no phone number to scan or dial', () => {
    // Asserted against the QR's own label, not against `<svg>` at all: the page
    // has drawn a wordmark since 2026-08-20, so "no svg" would fail on the brand
    // mark while saying nothing about the code.
    expect(unsetHtml).not.toContain('QR code');
    expect(unsetHtml).not.toContain('647');
    // Positive control: the live page DOES draw one, so the absence above is the
    // number being unset rather than the label having been renamed.
    expect(liveHtml).toContain('QR code — scan to text Hale');
  });

  it('keeps the venue token out of the page entirely — there is nothing to attach it to', () => {
    expect(unsetHtml).not.toContain('earlyon-richmondhill');
  });

  it('hides the contact card — /hale.vcf 404s while the number is unset', () => {
    expect(unsetHtml).not.toContain(CONTACT_CARD_PATH);
    expect(unsetHtml).not.toContain('Save Hale to your contacts');
  });
});
