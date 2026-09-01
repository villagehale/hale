import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CONTACT_CARD_PATH } from '~/lib/contact-card.js';
import { TextEntry } from './text-entry.js';

/**
 * The /text chooser (F14) — the page a QR card, a poster, a forwarded link, or
 * the site's own "Message Hale" CTAs open. The states that must be honest:
 *
 *   number live   → pick where we talk: the live channels as buttons, ordered by
 *                   the UA hint (never gated by it), the QR + copy chip covering
 *                   desktop, and the `(via <code>)` token riding in EVERY
 *                   channel's pre-filled body (poster attribution is sacred).
 *   number unset  → no sms: anywhere, email is the only path, and the page says
 *                   so plainly — the pre-chooser fallback, verbatim.
 *
 * Rendered to static markup — TextEntry is a pure server component.
 */

const LIVE_NUMBER = '+16475551234';

function render(props: Partial<Parameters<typeof TextEntry>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(TextEntry, {
      source: 'earlyon-richmondhill',
      smsNumber: LIVE_NUMBER,
      platform: 'apple',
      ...props,
    }),
  );
}

const liveHtml = render();
const liveNoSourceHtml = render({ source: null });
const unsetHtml = render({ smsNumber: '' });

/** Anchor tags only — the QR encodes an sms: URI as path data, which is not a
 * button and must not satisfy or violate the button pins. */
function anchors(html: string): string[] {
  return [...html.matchAll(/<a\s[^>]*>/g)].map((m) => m[0]);
}

/** The QR's single path — the module grid, drawn inline. Read through the QR's
 * OWN <svg> rather than off the first <path> on the page: the wordmark and the
 * handoff tiles are drawn art too. */
function qrPath(html: string): string {
  const svg = /<svg[^>]*QR code[\s\S]*?<\/svg>/.exec(html)?.[0] ?? '';
  return /<path d="([^"]+)"/.exec(svg)?.[1] ?? '';
}

describe('TextEntry (chooser copy)', () => {
  it('welcomes and asks the one question — pick where we talk', () => {
    expect(liveHtml).toContain('Welcome. Pick where we talk.');
    expect(liveHtml).toContain(
      'Your first message is already written — you send it, I reply. I never message first.',
    );
  });

  it('keeps the pre-chooser headline on the email-fallback state — there is nothing to pick yet', () => {
    expect(unsetHtml).toContain('Change the names to yours and send.');
    expect(unsetHtml).not.toContain('Pick where we talk');
  });

  it('says Messages, never iMessage — sms: opens the app named Messages on both platforms', () => {
    for (const html of [liveHtml, render({ platform: 'android' })]) {
      expect(html).not.toContain('iMessage');
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

describe('TextEntry — the channel matrix, rendered', () => {
  const WA = { whatsappNumber: LIVE_NUMBER };

  it('apple: Messages primary carrying the pre-filled body and venue token, wired sms', () => {
    // React escapes the `&` of the cross-platform `?&body=` form into `&amp;`.
    expect(liveHtml).toContain(
      'href="sms:+16475551234?&amp;body=Maya%20is%204%2C%20Theo%20is%2018%20months%2C%20L3R%20(via%20earlyon-richmondhill)"',
    );
    expect(liveHtml).toContain('Continue in Messages');
    const primary = anchors(liveHtml).find((a) => a.includes('href="sms:')) ?? '';
    expect(primary).toContain('btn-primary');
    expect(primary).toContain('data-cta="cta_text_click"');
    expect(primary).toContain('data-cta-placement="text_entry"');
    expect(primary).toContain('data-cta-channel="sms"');
  });

  it('apple with WhatsApp live: WhatsApp is the secondary, wired whatsapp', () => {
    const html = render(WA);
    expect(html).toContain('Continue in Messages');
    expect(html).toContain('Or use WhatsApp');
    const wa = anchors(html).find((a) => a.includes('wa.me')) ?? '';
    expect(wa).toContain('btn-secondary');
    expect(wa).toContain('data-cta="cta_whatsapp_click"');
    expect(wa).toContain('data-cta-channel="whatsapp"');
    // Ordered: the sms anchor renders before the wa.me one.
    expect(html.indexOf('href="sms:')).toBeLessThan(html.indexOf('wa.me'));
  });

  it('android with WhatsApp live: WhatsApp primary, Messages still one tap away — the hint never gates', () => {
    const html = render({ platform: 'android', ...WA });
    expect(html).toContain('Continue on WhatsApp');
    expect(html).toContain('Or use Messages');
    expect(html.indexOf('wa.me')).toBeLessThan(html.indexOf('href="sms:'));
    const wa = anchors(html).find((a) => a.includes('wa.me')) ?? '';
    expect(wa).toContain('btn-primary');
  });

  it('android with WhatsApp dark: Messages primary, and no dead WhatsApp button anywhere', () => {
    const html = render({ platform: 'android' });
    expect(html).toContain('Continue in Messages');
    expect(html).not.toContain('wa.me');
    expect(html).not.toContain('WhatsApp');
  });

  it('desktop-other: never an sms: button — dead on Windows/Linux — and the QR card leads', () => {
    const html = render({ platform: 'desktop-other', ...WA });
    expect(anchors(html).filter((a) => a.includes('href="sms:'))).toEqual([]);
    // WhatsApp Web is offered iff live…
    expect(html).toContain('Continue on WhatsApp');
    // …and the QR card renders BEFORE any channel button.
    expect(html.indexOf('QR code')).toBeLessThan(html.indexOf('wa.me'));
    // WhatsApp dark: no buttons at all — the QR card carries the page.
    const dark = render({ platform: 'desktop-other' });
    expect(anchors(dark).filter((a) => a.includes('href="sms:'))).toEqual([]);
    expect(dark).not.toContain('wa.me');
    expect(dark).toContain('QR code');
  });

  it('unknown platform (no UA): the safest layout — same as desktop-other', () => {
    const html = render({ platform: 'unknown' });
    expect(anchors(html).filter((a) => a.includes('href="sms:'))).toEqual([]);
    expect(html).toContain('QR code');
  });

  it('threads the venue token into EVERY channel link — poster attribution is sacred', () => {
    const html = render({ platform: 'android', ...WA });
    const channelAnchors = anchors(html).filter(
      (a) => a.includes('href="sms:') || a.includes('wa.me'),
    );
    expect(channelAnchors).toHaveLength(2);
    for (const anchor of channelAnchors) {
      expect(anchor, 'the (via <code>) token must ride in this channel’s body').toContain(
        '(via%20earlyon-richmondhill)',
      );
    }
  });

  it('pre-fills the locked intake sample when no venue sent them', () => {
    expect(liveNoSourceHtml).toContain(
      'href="sms:+16475551234?&amp;body=Maya%20is%204%2C%20Theo%20is%2018%20months%2C%20L3R"',
    );
  });

  it('keeps the dark page dark: no channel buttons on the email-fallback state even if the WhatsApp env leaks in', () => {
    const darkWithWhatsApp = render({ source: null, smsNumber: '', ...WA });
    expect(darkWithWhatsApp).not.toContain('wa.me');
    expect(darkWithWhatsApp).not.toContain('sms:');
  });
});

describe('TextEntry — the handoff visual', () => {
  it('draws the neutral speech bubble in site tokens when Messages leads — never Apple’s green icon', () => {
    expect(liveHtml).toContain('var(--color-sky-tint)');
    expect(liveHtml).not.toContain('#25D366');
  });

  it('shows the official WhatsApp glyph only when WhatsApp is the primary', () => {
    const waLeads = render({ platform: 'android', whatsappNumber: LIVE_NUMBER });
    expect(waLeads).toContain('#25D366');
    // Secondary WhatsApp does not put the glyph in the handoff tile.
    const waSecond = render({ whatsappNumber: LIVE_NUMBER });
    expect(waSecond).not.toContain('#25D366');
  });

  it('is decorative, and absent from the email-fallback state', () => {
    const tile = /<div[^>]*aria-hidden="true"[^>]*>[\s\S]*?var\(--color-sky-tint\)/.exec(liveHtml);
    expect(tile, 'the handoff row must be aria-hidden').not.toBeNull();
    expect(unsetHtml).not.toContain('var(--color-sky-tint)');
  });
});

describe('TextEntry (number live) — the desktop card and the disclosures', () => {
  it('never prints the digits — a copy chip stands in for the readable number', () => {
    // Positive controls so the absences cannot pass vacuously: the composer link
    // and the copy chip are both present…
    expect(liveHtml).toContain('sms:+16475551234');
    expect(liveHtml).toContain('Copy number');
    // …and the number never renders as text (the founder rule: reachable, never
    // displayed).
    expect(liveHtml).not.toContain('+1 (647) 555-1234');
    expect(liveHtml).not.toContain('(647) 555-1234');
  });

  it('offers the contact card while the number is live — /hale.vcf 404s without one', () => {
    expect(liveHtml).toContain(`href="${CONTACT_CARD_PATH}"`);
    expect(liveHtml).toContain('Save Hale to your contacts');
    const anchor = new RegExp(`<a[^>]*href="${CONTACT_CARD_PATH}"[^>]*>`).exec(liveHtml)?.[0] ?? '';
    expect(anchor).toContain('btn-secondary');
    // The primary CTA keeps its weight — one btn-primary, and it is a composer.
    expect([...liveHtml.matchAll(/btn-primary/g)]).toHaveLength(1);
  });

  it('renders a scannable QR of the primary channel’s URI — the desktop path, where sms: links are dead', () => {
    expect(liveHtml).toContain('aria-label="QR code — scan to text Hale"');
    // A real module grid, not a placeholder box: one path move per dark module.
    const modules = [...qrPath(liveHtml).matchAll(/M/g)].length;
    expect(modules).toBeGreaterThan(50);
    // Drawn inline from the URI, not fetched — no third-party chart/image endpoint.
    expect(liveHtml).not.toContain('chart.googleapis');
  });

  it('encodes the actual link — a different venue produces a different QR', () => {
    expect(qrPath(liveHtml)).not.toBe(qrPath(liveNoSourceHtml));
  });

  it('draws the code on its own light plate, never in theme colours', () => {
    const svg = /<svg[^>]*QR code[\s\S]*?<\/svg>/.exec(liveHtml)?.[0] ?? '';
    expect(svg).toContain('fill="#ffffff"');
    expect(svg).toContain('fill="#17294a"');
    expect(svg, 'a themed fill would invert the code in dark').not.toContain('var(--');
  });

  it('discloses the attribution token instead of smuggling it', () => {
    expect(liveHtml).toContain('(via earlyon-richmondhill)');
    expect(liveNoSourceHtml).not.toContain('(via');
  });

  it('carries the STOP line on the terms row — mobile states never showed the scan hint’s copy', () => {
    expect(liveHtml).toContain('Standard message rates apply; reply STOP any time.');
    // The dark state keeps its own honest line instead.
    expect(unsetHtml).not.toContain('reply STOP');
  });
});

describe('TextEntry (the other two locales)', () => {
  it('offers the contact card in French and Chinese too', () => {
    // A key missing from fr.json/zh.json renders as the key path rather than
    // failing the build, so the translated labels are pinned here.
    const fr = render({ source: null, locale: 'fr' });
    const zh = render({ source: null, locale: 'zh' });
    expect(fr).toContain('Enregistrer Hale dans vos contacts');
    expect(zh).toContain('把 Hale 存入通讯录');
    for (const html of [fr, zh]) expect(html).not.toContain('Text.saveContact');
  });

  it('speaks the chooser in French and Chinese — no key paths, no English fallback', () => {
    const fr = render({ source: null, locale: 'fr', whatsappNumber: LIVE_NUMBER });
    const zh = render({ source: null, locale: 'zh', whatsappNumber: LIVE_NUMBER });
    expect(fr).toContain('Continuer dans Messages');
    expect(zh).toContain('继续用「信息」聊');
    for (const html of [fr, zh]) {
      expect(html).not.toContain('Text.chooserHeadline');
      expect(html).not.toContain('Text.continueMessages');
    }
  });
});

describe('TextEntry (number not provisioned — the pre-chooser state, verbatim)', () => {
  it('offers email only, and never a broken sms: link', () => {
    expect(unsetHtml).not.toContain('sms:');
    expect(unsetHtml).toContain('href="mailto:aloha@villagehale.com"');
    expect(unsetHtml).toContain('aloha@villagehale.com');
  });

  it('never leaves mailto as the only path — the address is copyable in place', () => {
    expect(unsetHtml).toContain('Copy aloha@villagehale.com');
  });

  it('says plainly that the number is not live and the page is unannounced', () => {
    expect(unsetHtml).toContain('The number’s coming — this page isn’t announced yet.');
  });

  it('renders no QR and no phone number to scan or dial', () => {
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
