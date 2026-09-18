import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CONTACT_CARD_PATH } from '~/lib/contact-card.js';
import { INTAKE_PREFILL } from '~/lib/text-entry.js';
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

/** A bubble's rendered text, tags stripped — read through the shared landing
 * primitives (`v4-bubble` / `v4-bubble-out|in`) so a page that grew its own
 * second bubble style would return null here rather than pass. The bubble's own
 * sr-only caption comes off FIRST: it is said to the reader the layout does not
 * reach, and what is left is the message a sighted reader sees. */
function bubbleText(html: string, dir: 'out' | 'in'): string | null {
  const match = new RegExp(`<p class="v4-bubble v4-bubble-${dir}"[^>]*>([\\s\\S]*?)</p>`).exec(html);
  if (match?.[1] === undefined) return null;
  return match[1]
    .replace(/<span class="sr-only">[\s\S]*?<\/span>/, '')
    .replace(/<[^>]+>/g, '')
    .trim();
}

/** The caption a bubble carries for screen readers, or null when it carries none. */
function bubbleSrLabel(html: string, dir: 'out' | 'in'): string | null {
  const match = new RegExp(
    `<p class="v4-bubble v4-bubble-${dir}"[^>]*><span class="sr-only">([\\s\\S]*?)</span>`,
  ).exec(html);
  return match?.[1]?.trim() ?? null;
}

function messages(locale: 'en' | 'fr' | 'zh'): { Text: Record<string, string> } {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL(`../messages/${locale}.json`, import.meta.url)), 'utf8'),
  );
}

/** en.json Text.greeting, escaped the way react-dom/server writes it — the same
 * bytes app/text-page-copy.test.ts pins against apps/web's intake copy. */
const PINNED_GREETING = (messages('en').Text.greeting as string)
  .replaceAll('&', '&amp;')
  .replaceAll("'", '&#x27;');

/** globals.css as postcss sees it — the fill rules below are a HIERARCHY claim
 * (one navy fill on the page, and it is the button), which no rendered markup
 * can carry: the bubbles and the CTA differ only in their declared background. */
const CSS_ROOT = postcss.parse(
  readFileSync(fileURLToPath(new URL('../app/globals.css', import.meta.url)), 'utf8'),
);

function declaration(selector: string, prop: string): string | undefined {
  let value: string | undefined;
  CSS_ROOT.walkRules(selector, (rule) => {
    rule.walkDecls(prop, (decl) => {
      value = decl.value;
    });
  });
  return value;
}

/** The QR's single path — the module grid, drawn inline. Read through the QR's
 * OWN <svg> rather than off the first <path> on the page: the wordmark and the
 * handoff tiles are drawn art too. */
function qrPath(html: string): string {
  const svg = /<svg[^>]*QR code[\s\S]*?<\/svg>/.exec(html)?.[0] ?? '';
  return /<path d="([^"]+)"/.exec(svg)?.[1] ?? '';
}

describe('TextEntry (566 one-tap — WhatsApp dark)', () => {
  it('leads with what Hale IS — the five-second line, both arms', () => {
    for (const html of [liveHtml, unsetHtml]) {
      expect(html).toContain('The family assistant you text.');
      // ONE sentence. "No app, no account" moved out of the lede: the trust
      // strip already says it, and above the fold every restated line is a line
      // between a stranger and the button.
      expect(html).toContain(
        'Hale finds activities that fit your little one, keeps sign-up mornings from sneaking up, and checks in on how it goes.',
      );
      expect(html).not.toContain('No app, no account — just this text thread.');
    }
    // Positive control: the fact itself is still on the page, once.
    expect([...liveHtml.matchAll(/No app/g)]).toHaveLength(1);
    expect(liveHtml).not.toContain('Change the names to yours and send.');
    expect(liveHtml).not.toContain('Pick where we talk');
    expect(liveHtml).not.toContain('Welcome.');
  });

  it('says what to DO in ONE folded line — the three numbered steps are gone', () => {
    // The only beat the exchange does not already show is WHEN the payoff lands;
    // the greeting bubble itself asks for the ages and the postal code.
    expect(liveHtml).toContain('Your first watch comes back the same minute.');
    expect(liveHtml).not.toContain('Answer one text with your kids’ ages and postal code;');
    // The numbered row is retired: the exchange shows the first beat, the folded
    // line says the rest. No <ol> survives anywhere on the page.
    expect([...liveHtml.matchAll(/<ol[\s>]/g)]).toHaveLength(0);
    expect(liveHtml).not.toContain('Say hi — the first message is already written.');
    expect(liveHtml).not.toContain('Answer one text: kids’ names, ages, postal code.');
    // The dark page promises no text back, so it makes no promises about one.
    expect(unsetHtml).not.toContain('first watch comes back the same minute');
  });

  it('shows what comes BACK — an honestly-labeled bubble, absent while no channel is live', () => {
    expect(liveHtml).toContain('The text you’ll get back:');
    expect(liveHtml).toContain('Hi, I&#x27;m Hale. I find activities that fit your little one');
    expect(unsetHtml).not.toContain('Reply with your kids');
    expect(unsetHtml).not.toContain('The text you’ll get back:');
  });

  it('carries the trust strip beside the door — free, no app, no account, STOP, privacy', () => {
    expect(liveHtml).toContain('Free · No app · No account · Reply STOP anytime');
    const trust = /Free · No app[\s\S]{0,200}?<a[^>]*href="\/privacy"[^>]*>/.exec(liveHtml);
    expect(trust, 'the trust strip must end in the privacy link').not.toBeNull();
    // The dark page has no number to STOP.
    expect(unsetHtml).not.toContain('Reply STOP anytime');
  });

  it('is one Text Hale button — no picker, no channel names', () => {
    expect(liveHtml).toContain('>Text Hale</a>');
    expect(liveHtml).not.toContain('Continue in Messages');
    expect(liveHtml).not.toContain('Or use Messages');
    expect(liveHtml).not.toContain('iMessage');
    expect(liveHtml).not.toContain('WhatsApp');
    expect([...liveHtml.matchAll(/btn-primary/g)]).toHaveLength(1);
  });

  it('offers the sms: composer only where it works — desktop-other and unknown get the QR instead', () => {
    for (const platform of ['apple', 'android', 'desktop-mac'] as const) {
      const html = render({ platform });
      expect(html).toContain('>Text Hale</a>');
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
      expect(html).not.toContain('>Text Hale</a>');
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

/**
 * Composer-as-hero (founder decision 2026-09-16). The page's centre of gravity
 * is the EXCHANGE — the message the parent is about to send, and the reply Hale
 * really sends back — drawn with the landing hero's own bubble primitives so the
 * two surfaces are one messaging idiom rather than two.
 */
describe('TextEntry — the exchange is the hero', () => {
  it('sends what the composer actually carries: INTAKE_PREFILL, with no attribution token', () => {
    expect(bubbleText(liveHtml, 'out')).toBe(INTAKE_PREFILL);
    // The venue token rides in the href, never in the bubble the parent reads.
    expect(bubbleText(liveHtml, 'out')).not.toContain('(via');
    expect(bubbleText(liveHtml, 'out')).not.toContain('earlyon-richmondhill');
    // Positive control: this render DOES carry a source, so the absence above is
    // the bubble being clean rather than the source having gone missing.
    expect(liveHtml).toContain('(via%20earlyon-richmondhill)');
  });

  it('receives Hale’s pinned greeting, byte-for-byte, in the received bubble', () => {
    expect(bubbleText(liveHtml, 'in')).toBe(PINNED_GREETING);
    expect(PINNED_GREETING).toContain('sign-up mornings'); // the pin is not empty
  });

  it('leaves the CTA as the only navy fill: the sent bubble is a message, not a button', () => {
    // The landing's out bubble IS navy on cream — the same ink and the same
    // full radius as .btn-primary. On /text that bubble sits 300px ABOVE the
    // real button, so squinting lands the eye on the fake one. The page-scoped
    // override retints it; the primitive itself is untouched.
    expect(declaration('.btn-primary', 'background')).toBe('var(--color-navy)');
    expect(declaration('.v4-bubble-out', 'background')).toBe('var(--color-navy)');
    const sent = declaration('.text-thread .v4-bubble-out', 'background');
    expect(sent, '/text must retint the sent bubble').toBeDefined();
    expect(sent).not.toBe('var(--color-navy)');
    expect(sent).toBe('var(--color-sky-tint)');
    // …and the two bubbles are never the same fill as each other.
    expect(declaration('.text-thread .v4-bubble-in', 'background')).toBe(
      'var(--color-apricot-tint)',
    );
  });

  it('reuses the landing’s bubble primitives — no second bubble style on the site', () => {
    expect(liveHtml).toContain('class="v4-bubble v4-bubble-out"');
    expect(liveHtml).toContain('class="v4-bubble v4-bubble-in"');
    // The sent bubble reads first: a thread runs parent → Hale.
    expect(liveHtml.indexOf('v4-bubble-out')).toBeLessThan(liveHtml.indexOf('v4-bubble-in'));
    // Labelled as what WILL be sent / WILL come back, never as a live thread.
    expect(liveHtml).toContain('What you’ll send:');
    expect(liveHtml).toContain('The text you’ll get back:');
  });

  it('puts ONE primary CTA directly under the exchange, and it is the sms: composer', () => {
    const primaries = anchors(liveHtml).filter((a) => a.includes('btn-primary'));
    expect(primaries).toHaveLength(1);
    expect(primaries[0]).toContain('href="sms:+16475551234?&amp;body=');
    expect(primaries[0]).toContain('data-cta="cta_text_click"');
    expect(liveHtml).toContain('>Text Hale</a>');
    // Order: exchange, then the folded line, then the button.
    expect(liveHtml.indexOf('v4-bubble-in')).toBeLessThan(
      liveHtml.indexOf('first watch comes back the same minute'),
    );
    expect(liveHtml.indexOf('first watch comes back the same minute')).toBeLessThan(
      liveHtml.indexOf('btn-primary'),
    );
  });

  it('keeps its future-tense caption INSIDE each bubble, so the framing cannot be orphaned', () => {
    // The visible label is repeated to screen readers from within the bubble and
    // hidden from them where it sits, so the honesty ("you’ll send" / "you’ll get
    // back") travels with the message instead of relying on DOM adjacency — and
    // no reader hears it twice.
    expect(bubbleSrLabel(liveHtml, 'out')).toBe('What you’ll send:');
    expect(bubbleSrLabel(liveHtml, 'in')).toBe('The text you’ll get back:');
    expect(liveHtml).toContain(
      '<p class="text-thread-label text-thread-label-out" aria-hidden="true">What you’ll send:</p>',
    );
    expect(liveHtml).toContain(
      '<p class="text-thread-label" aria-hidden="true">The text you’ll get back:</p>',
    );
    // FR carries its own words into the bubble, not English ones.
    expect(bubbleSrLabel(render({ source: null, locale: 'fr' }), 'out')).toBe(
      'Ce que vous enverrez :',
    );
  });

  it('glosses the English prefill wherever the page is not English — and nowhere else', () => {
    // The out bubble is the literal SMS body, so it stays English in every
    // locale (a translated bubble would misrepresent what the composer sends).
    // The gloss beside it is how a FR/ZH reader learns what they are sending.
    for (const locale of ['fr', 'zh'] as const) {
      const html = render({ source: null, locale });
      expect(bubbleText(html, 'out')).toBe(INTAKE_PREFILL);
      expect(html).toContain('text-thread-gloss');
    }
    expect(render({ source: null, locale: 'fr' })).toContain(
      'En anglais : « Bonjour Hale 👋 prêt à commencer »',
    );
    expect(render({ source: null, locale: 'zh' })).toContain('英文：“你好 Hale 👋 我准备好开始了”');
    // English needs no gloss of English — the key exists, and it is the prefill
    // itself, which is exactly the condition that suppresses the line.
    expect(liveHtml).not.toContain('text-thread-gloss');
    expect(messages('en').Text.sentGloss).toBe(INTAKE_PREFILL);
  });

  it('has no exchange at all on the dark page — nothing is promised without a number', () => {
    expect(bubbleText(unsetHtml, 'out')).toBeNull();
    expect(bubbleText(unsetHtml, 'in')).toBeNull();
    expect(unsetHtml).not.toContain(INTAKE_PREFILL);
  });
});

describe('TextEntry — the channel matrix, rendered', () => {
  const WA = { whatsappNumber: LIVE_NUMBER };

  it('apple WhatsApp dark: one Text Hale sms: CTA carrying the pre-filled body and venue token', () => {
    // React escapes the `&` of the cross-platform `?&body=` form into `&amp;`.
    expect(liveHtml).toContain(
      'href="sms:+16475551234?&amp;body=Hi%20Hale%20%F0%9F%91%8B%20ready%20to%20get%20started%20(via%20earlyon-richmondhill)"',
    );
    expect(liveHtml).toContain('>Text Hale</a>');
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

  it('android with WhatsApp dark: one Text Hale button, and no dead WhatsApp button anywhere', () => {
    const html = render({ platform: 'android' });
    expect(html).toContain('>Text Hale</a>');
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

  it('pre-fills the locked hello when no venue sent them', () => {
    expect(liveNoSourceHtml).toContain('href="sms:+16475551234?&amp;body=Hi%20Hale%20%F0%9F%91%8B%20ready%20to%20get%20started"');
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

  it('discloses the attribution in words — the raw token rides only inside hrefs, never in copy', () => {
    // The disclosure line says a tag is in the message; the token itself stays
    // out of every text node (founder lock 2026-09-01). Strip tags (attributes
    // go with them) and the page prose must be token-free…
    const textNodes = liveHtml.replace(/<[^>]+>/g, ' ');
    expect(textNodes).not.toContain('(via');
    expect(textNodes).not.toContain('earlyon-richmondhill');
    expect(liveHtml).toContain('which poster or friend sent you');
    // …while the composer href still carries it (positive control — the
    // absence above must mean "moved into the link", not "attribution lost").
    expect(liveHtml).toContain('(via%20earlyon-richmondhill)');
    expect(liveNoSourceHtml).not.toContain('(via');
    expect(liveNoSourceHtml).not.toContain('which poster or friend sent you');
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

  it('speaks the exchange frame in French and Chinese — no key paths', () => {
    const fr = render({ source: null, locale: 'fr' });
    const zh = render({ source: null, locale: 'zh' });
    expect(fr).toContain('Ce que vous enverrez :');
    expect(zh).toContain('你会发出的内容：');
    expect(fr).toContain('Votre première veille arrive dans la minute.');
    expect(zh).toContain('你的第一份关注同一分钟就会回来。');
    for (const html of [fr, zh]) {
      expect(html).not.toContain('Text.sentLabel');
      expect(html).not.toContain('Text.afterSend');
      // The prefill is a literal the parent will send — never translated.
      expect(bubbleText(html, 'out')).toBe(INTAKE_PREFILL);
    }
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

  it('previews Hale’s real first reply per locale — FR gets the French twin, ZH shows the English under a translated label', () => {
    const fr = render({ source: null, locale: 'fr' });
    // The FR greeting is copy.ts verbatim, GSM-7 fold included (l&#x27;age).
    expect(fr).toContain('Bonjour, je suis Hale.');
    expect(fr).toContain('l&#x27;age de vos enfants');
    // ZH: copy.ts has no Chinese greeting, and the page never invents Hale
    // speech — the bubble stays English, the frame label says so in Chinese.
    const zh = render({ source: null, locale: 'zh' });
    expect(zh).toContain('（英文原文）');
    expect(zh).toContain('Hi, I&#x27;m Hale. I find activities that fit your little one');
  });
});

describe('TextEntry — the chooser arm keeps the five-second frame (WhatsApp live)', () => {
  it('adds the what-is line and the preview bubble above the channel buttons', () => {
    const html = render({ whatsappNumber: LIVE_NUMBER });
    expect(html).toContain(
      'Hale finds activities that fit your little one, keeps sign-up mornings from sneaking up, and checks in on how it goes.',
    );
    expect(html).toContain('The text you’ll get back:');
    // The bubble sits above the first channel door.
    expect(html.indexOf('I find activities that fit your little one')).toBeLessThan(
      html.indexOf('href="sms:'),
    );
    // Structure kept: still the chooser headline, no numbered steps row.
    expect(html).toContain('Welcome. Pick where we talk.');
    expect(html).not.toContain('<ol');
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
