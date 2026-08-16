import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
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

/** The QR's single path — the module grid, drawn inline. */
function qrPath(html: string): string {
  return html.match(/<path d="([^"]+)"/)?.[1] ?? '';
}

describe('TextEntry (persona copy)', () => {
  it('leads with the chief-of-staff introduction and the what-I-watch line', () => {
    for (const html of [liveHtml, unsetHtml]) {
      expect(html).toContain('Hi, I’m Hale — your family’s quiet chief of staff.');
      expect(html).toContain(
        'I keep watch over your week — registrations, programs, checkups, weather — and text you before things matter.',
      );
    }
  });

  it('names only watched things that exist — no school paperwork Hale cannot see', () => {
    // Same bar the landing holds (landing-f14.test.ts): the health timeline and the
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
      'href="sms:+16475551234?&amp;body=Hi%20(via%20earlyon-richmondhill)"',
    );
    expect(liveHtml).toContain('Text me');
  });

  it('pre-fills the bare greeting when no venue sent them', () => {
    expect(liveNoSourceHtml).toContain('href="sms:+16475551234?&amp;body=Hi"');
  });

  it('never prints the digits — a copy chip stands in for the readable number', () => {
    // Positive controls so the absences cannot pass vacuously: the composer link
    // and the copy chip are both present…
    expect(liveHtml).toContain('sms:+16475551234');
    expect(liveHtml).toContain('Copy my number');
    // …and the number never renders as text (the founder rule: reachable, never
    // displayed).
    expect(liveHtml).not.toContain('+1 (647) 555-1234');
    expect(liveHtml).not.toContain('(647) 555-1234');
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

  it('discloses the attribution token instead of smuggling it', () => {
    expect(liveHtml).toContain('(via earlyon-richmondhill)');
    expect(liveNoSourceHtml).not.toContain('(via');
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
    expect(unsetHtml).not.toContain('<svg');
    expect(unsetHtml).not.toContain('647');
  });

  it('keeps the venue token out of the page entirely — there is nothing to attach it to', () => {
    expect(unsetHtml).not.toContain('earlyon-richmondhill');
  });
});
