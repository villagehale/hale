import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';
import { describe, expect, it } from 'vitest';
import { poseAt, REVEAL_DELAY_MS, STOPS, trackForSlot } from './choreography';
import { LEAD_SLOT, MOMENTS } from './moments';

const here = (name: string) => readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf8');

const CSS = here('pallet-v2b.css');
const LANDING = here('landing-v2b.tsx');
const LIVE = readFileSync(
  fileURLToPath(new URL('../chief-of-staff.tsx', import.meta.url)),
  'utf8',
);

/** The list literal between a `const NAME = [` and its closing `] as const;`. */
function stringArray(source: string, name: string): string[] {
  const block = source.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\] as const;`))?.[1];
  if (!block) throw new Error(`${name} not found`);
  return [...block.matchAll(/'([^']+)'/g)].map((m) => m[1] as string);
}

describe('v2b — @layer discipline (SITE-01, scoped stylesheet)', () => {
  it('has no unlayered class rule, so Tailwind utilities still win', () => {
    const unlayered: string[] = [];
    postcss.parse(CSS).walkRules((rule) => {
      if (!/\.[-_a-zA-Z]/.test(rule.selector)) return;
      let parent: postcss.Node | undefined = rule.parent;
      let layered = false;
      while (parent) {
        if (parent.type === 'atrule' && (parent as postcss.AtRule).name === 'layer') layered = true;
        parent = parent.parent;
      }
      if (!layered) unlayered.push(rule.selector.replace(/\s+/g, ' ').trim());
    });
    expect(unlayered).toEqual([]);
  });

  it('generates its fan stylesheet inside @layer too', async () => {
    const { fanStyleSheet } = await import('./choreography');
    expect(fanStyleSheet(7).startsWith('@layer components{')).toBe(true);
  });
});

describe('v2b — palette discipline', () => {
  /** Comments carry PR numbers like `#453`, which are not colours. */
  const CSS_RULES = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

  /** Every hex in the stylesheet, lowercased and expanded to 6 digits. */
  const hexes = new Set(
    [...CSS_RULES.matchAll(/#([0-9a-fA-F]{3,8})\b/g)].map(([, raw]) => {
      const h = raw as string;
      return (h.length === 3 ? [...h].map((c) => c + c).join('') : h.slice(0, 6)).toLowerCase();
    }),
  );

  it('uses only Hale palette values — no off-palette hues', () => {
    const allowed = new Set([
      'f7f4ec', 'fdfcfa', 'ffffff', 'f7f9fc', // warm grounds + card
      '17294a', '5c6b87', '8b95a9', // navy ink ladder
      'e4e7ee', 'eef1f7', // rules + navy wash
      'b26b1f', 'fef0c7', // amber (fill) + amber wash
      '9c3b54', 'f3d7dd', // berry (fill) + berry wash
      '14120e', '0f0e0a', '1e1b15', '282318', '2e2a22', '241f17', // Shore warm-dark ladder
      'f6f1e7', 'c7d3e6', '9bb0d0', // Shore cream ink ladder
      '33260f', '3a1f1a', '1e2740', // Shore dark tints
    ]);
    expect([...hexes].filter((h) => !allowed.has(h))).toEqual([]);
  });

  it('never sets amber as a text colour — amber is FILL only', () => {
    // Any `color:` declaration resolving to the amber hex would break the
    // 4.6:1-on-cream fill-only rule the site's tokens document.
    const colorDecls = [...CSS.matchAll(/(?<!-)\bcolor:\s*([^;]+);/g)].map(([, v]) =>
      (v as string).trim(),
    );
    expect(colorDecls.filter((v) => v.includes('#b26b1f') || v === 'var(--v2b-amber)')).toEqual([]);
  });

  it('has no purple gradient and no emoji anywhere in the variant', () => {
    // `Emoji_Presentation` rather than `Extended_Pictographic`: the latter also
    // covers text-default signs like © in the footer, which is typography.
    for (const source of [CSS, LANDING, here('moments.ts'), here('deck.tsx')]) {
      expect(/(?:linear|radial)-gradient[^;]*(?:purple|violet|magenta|#[89a-f][0-9a-f]{3}[ef][0-9a-f])/i.test(source)).toBe(false);
      expect(/\p{Emoji_Presentation}|️/u.test(source)).toBe(false);
    }
  });
});

describe('v2b — honesty pins', () => {
  it('mirrors the live page’s municipality list exactly', () => {
    expect(stringArray(LANDING, 'MUNICIPALITIES')).toEqual(stringArray(LIVE, 'MUNICIPALITIES'));
  });

  it('never renders the number’s digits — only sms:, QR and clipboard', () => {
    // `displaySmsNumber` is the site's digit formatter; v2b must not reach for it.
    expect(LANDING).not.toContain('displaySmsNumber');
    expect(/\+1\s*\(?\d{3}/.test(LANDING)).toBe(false);
  });

  it('labels the cards as examples rather than as a record of real messages', () => {
    expect(LANDING).toContain('Example messages');
  });

  it('offers email, not a dead sms: link, when no number is provisioned', () => {
    // `smsHref` is `string | null`, so an unguarded `href={smsHref}` is a type
    // error — the typecheck is what makes a dead link unexpressible. What a
    // source pin can add is that the nullability exists at all, and that the
    // honest fallback copy and address are really there.
    expect(LANDING).toContain('const smsHref = smsNumber ? buildSmsHref(smsNumber, null) : null;');
    expect(LANDING).toContain('The number’s coming.');
    expect(LANDING).toContain('mailto:${CONTACT_EMAIL}');
    // Each of the four CTA sites (header, hero, section two, close) branches.
    expect(LANDING.match(/smsHref \?/g)?.length).toBeGreaterThanOrEqual(4);
  });

  it('keeps the sticky mobile CTA and the noindex preview route', () => {
    expect(LANDING).toContain('v2b-sticky-cta');
    const route = readFileSync(
      fileURLToPath(new URL('../../../app/preview/landing-v2b/page.tsx', import.meta.url)),
      'utf8',
    );
    expect(route).toContain('robots: { index: false, follow: false }');
  });
});

describe('v2b — the choreography', () => {
  it('gathers every card onto one place at the stack beat', () => {
    const stackAt = STOPS[1];
    const poses = MOMENTS.map((m) => poseAt(trackForSlot(m.slot, 'desktop'), stackAt));
    for (const pose of poses) {
      expect(pose.x).toBe(0);
      expect(pose.rotate).toBe(0);
      expect(pose.y).toBe(poses[0]?.y);
    }
  });

  it('spreads the cards apart again at the cascade beat, in slot order', () => {
    const ladder = MOMENTS.map((m) => poseAt(trackForSlot(m.slot, 'desktop'), 1));
    const xs = ladder.map((p) => p.x);
    const ys = ladder.map((p) => p.y);
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
    expect(ys).toEqual([...ys].sort((a, b) => a - b));
    expect(new Set(xs).size).toBe(MOMENTS.length);
  });

  it('fits inside a 390px viewport on mobile at every beat', () => {
    // Half the card plus its offset must clear half the narrowest phone we
    // support, or the page scrolls sideways — the failure the template's
    // ±480px fan would have caused verbatim.
    const halfCard = 214 / 2;
    for (const moment of MOMENTS) {
      const track = trackForSlot(moment.slot, 'mobile');
      for (let p = 0; p <= 1; p += 0.02) {
        const pose = poseAt(track, p);
        expect(Math.abs(pose.x) * pose.scale + halfCard).toBeLessThan(320 / 2 + halfCard);
        expect(Math.abs(pose.x)).toBeLessThan(60);
      }
    }
  });

  it('reveals the cards right to left, with the lead card entering first', () => {
    const delays = [...REVEAL_DELAY_MS];
    expect(delays).toEqual([...delays].sort((a, b) => b - a));
    expect(Math.min(...delays)).toBe(delays[delays.length - 1]);
  });
});

describe('v2b — the seven cards', () => {
  it('fills all seven slots exactly once, with one lead at the centre', () => {
    expect(MOMENTS.map((m) => m.slot).sort()).toEqual([0, 1, 2, 3, 4, 5, 6]);
    const leads = MOMENTS.filter((m) => m.lead);
    expect(leads).toHaveLength(1);
    expect(leads[0]?.slot).toBe(LEAD_SLOT);
  });

  it('gives every card a screen-reader label and some content', () => {
    for (const moment of MOMENTS) {
      expect(moment.label.length).toBeGreaterThan(12);
      expect(Boolean(moment.bubbles?.length || moment.brief)).toBe(true);
    }
  });

  it('keeps every card legible at 232px — no bubble runs long', () => {
    for (const moment of MOMENTS) {
      const bubbles = moment.bubbles ?? [];
      expect(bubbles.length).toBeLessThanOrEqual(3);
      const total = bubbles.reduce((n, b) => n + b.text.length, 0);
      expect(total).toBeLessThanOrEqual(200);
    }
  });

  it('writes every message in plain ASCII, as the real transport does', () => {
    // GSM-7 is the wire format; a curly quote or em dash on a card would be a
    // message Hale could not actually send in one segment.
    for (const moment of MOMENTS) {
      for (const bubble of moment.bubbles ?? []) {
        expect(bubble.text, bubble.text).toMatch(/^[\x20-\x7E]*$/);
      }
    }
  });

  it('never tells the parent a keyword to reply with', () => {
    // reply-resolver.md: "Hale never tells a parent to reply with a keyword."
    for (const moment of MOMENTS) {
      for (const bubble of moment.bubbles ?? []) {
        expect(bubble.text, bubble.text).not.toMatch(/\breply\s+(YES|NO|STOP)\b/i);
        expect(bubble.text, bubble.text).not.toMatch(/\bYES to confirm\b/);
      }
    }
  });
});
