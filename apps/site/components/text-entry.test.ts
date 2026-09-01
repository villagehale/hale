import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CONTACT_CARD_PATH } from '~/lib/contact-card.js';
import { TextEntry } from './text-entry.js';

/**
 * The /text entry surface (VIL-240 · M5, designer lock 566).
 *
 * WhatsApp sender is not approved. Production is one tap, not a picker:
 *
 *   SMS live, WhatsApp dark  → PR 566: one "Message Hale" button, locked headline,
 *                              Maya/Theo/L3R prefill. No channel names, no
 *                              empty iMessage/WhatsApp chooser. Where sms: is a
 *                              dead click (qrLeads) the QR card leads, no button.
 *   both live                → the chooser (a real choice exists).
 *   SMS unset                → email only, never a dead sms: link.
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

describe('TextEntry (566 one-tap — WhatsApp dark)', () => {
  it('leads with the locked recut headline and lede', () => {
    for (const html of [liveHtml, unsetHtml]) {
      expect(html).toContain('Change the names to yours and send.');
      expect(html).toContain('I text back the rec dates for that postal. No app.');
    }
    expect(liveHtml).not.toContain('Pick where we talk');
    expect(liveHtml).not.toContain('Welcome.');
  });

  it('is one Message Hale button — no picker, no channel names', () => {
    expect(liveHtml).toContain('>Message Hale</a>');
    expect(liveHtml).not.toContain('Continue in Messages');
    expect(liveHtml).not.toContain('Or use Messages');
    expect(liveHtml).not.toContain('iMessage');
    expect(liveHtml).not.toContain('WhatsApp');
    expect([...liveHtml.matchAll(/btn-primary/g)]).toHaveLength(1);
  });

  it('offers the sms: composer only where it works — desktop-other and unknown get the QR instead', () => {
    for (const platform of ['apple', 'android', 'desktop-mac'] as const) {
      const html = render({ platform });
      expect(html).toContain('>Message Hale</a>');
      expect(html).toContain('href="sms:+16475551234');
      expect(html).not.toContain('wa.me');
      expect(html).not.toContain('WhatsApp');
      expect(html).not.toContain('Pick where we talk');
      expect(html).not.toContain('iMessage');
    }
    // Windows/Linux/unknown: sms: is a dead click — no button renders, and the
    // QR card leads (above the contact-card CTA), exactly once.
    for (const platform of ['desktop-other', 'unknown'] as const) {
      const html = render({ platform });
      expect(anchors(html).filter((a) => a.includes('href="sms:'))).toEqual([]);
      expect(html).not.toContain('>Message Hale</a>');
      expect([...html.matchAll(/aria-label="QR code/g)]).toHaveLength(1);
      expect(html.indexOf('QR code')).toBeLessThan(html.indexOf('Save Hale to your contacts'));
      expect(html).not.toContain('wa.me');
      expect(html).not.toContain('Pick where we talk');
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

  it('apple WhatsApp dark: one Message Hale sms: CTA carrying the pre-filled body and venue token', () => {
    // React escapes the `&` of the cross-platform `?&body=` form into `&amp;`.
    expect(liveHtml).toContain(
      'href="sms:+16475551234?&amp;body=Maya%20is%204%2C%20Theo%20is%2018%20months%2C%20L3R%20(via%20earlyon-richmondhill)"',
    );
    expect(liveHtml).toContain('>Message Hale</a>');
    const primary = anchors(liveHtml).find((a) => a.includes('href="sms:')) ?? '';
    expect(primary).toContain('btn-primary');
    expect(primary).toContain('data-cta="cta_text_click"');
    expect(primary).toContain('data-cta-placement="text_entry"');
    expect(primary).toContain('data-cta-channel="sms"');
  });

  it('apple with WhatsApp live: WhatsApp is the secondary, wired whatsapp', () => {
    const html = render(WA);
    expect(html).toContain('Welcome. Pick where we talk.');
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

  it('android with WhatsApp dark: one Message Hale button, and no dead WhatsApp button anywhere', () => {
    const html = render({ platform: 'android' });
    expect(html).toContain('>Message Hale</a>');
    expect(html).not.toContain('Continue in Messages');
    expect(html).not.toContain('wa.me');
    expect(html).not.toContain('WhatsApp');
  });

  it('desktop-other: WhatsApp live withholds sms: (dead on Windows/Linux) and the QR card leads', () => {
    const html = render({ platform: 'desktop-other', ...WA });
    expect(anchors(html).filter((a) => a.includes('href="sms:'))).toEqual([]);
    // WhatsApp Web is offered iff live…
    expect(html).toContain('Continue on WhatsApp');
    // …and the QR card renders BEFORE any channel button.
    expect(html.indexOf('QR code')).toBeLessThan(html.indexOf('wa.me'));
    // WhatsApp dark: sms: is dead here too — no button, the QR card leads alone.
    const dark = render({ platform: 'desktop-other' });
    expect(anchors(dark).filter((a) => a.includes('href="sms:'))).toEqual([]);
    expect(dark).not.toContain('wa.me');
    expect(dark).toContain('QR code');
    expect(dark).not.toContain('Pick where we talk');
  });

  it('unknown platform (no UA): WhatsApp dark leads with the QR — no dead sms: button', () => {
    const html = render({ platform: 'unknown' });
    expect(anchors(html).filter((a) => a.includes('href="sms:'))).toEqual([]);
    expect(html).toContain('QR code');
    expect(html).not.toContain('Pick where we talk');
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

describe('TextEntry — the handoff visual (chooser only — WhatsApp live)', () => {
  it('is absent while WhatsApp is dark — Stanley is one tap, not a picker', () => {
    expect(liveHtml).not.toContain('var(--color-sky-tint)');
    expect(unsetHtml).not.toContain('var(--color-sky-tint)');
  });

  it('draws the neutral speech bubble in site tokens when Messages leads — never Apple’s green icon', () => {
    const html = render({ whatsappNumber: LIVE_NUMBER });
    expect(html).toContain('var(--color-sky-tint)');
    expect(html).not.toContain('#25D366');
  });

  it('shows the official WhatsApp glyph only when WhatsApp is the primary', () => {
    const waLeads = render({ platform: 'android', whatsappNumber: LIVE_NUMBER });
    expect(waLeads).toContain('#25D366');
    // Secondary WhatsApp does not put the glyph in the handoff tile.
    const waSecond = render({ whatsappNumber: LIVE_NUMBER });
    expect(waSecond).not.toContain('#25D366');
  });

  it('is decorative, and absent from the email-fallback state', () => {
    const html = render({ whatsappNumber: LIVE_NUMBER });
    const tile = /<div[^>]*aria-hidden="true"[^>]*>[\s\S]*?var\(--color-sky-tint\)/.exec(html);
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
