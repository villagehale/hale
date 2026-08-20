import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Wordmark } from '~/components/wordmark.js';

/**
 * SITE-02 gate — the display type may never be set in a weight the loaded face
 * does not ship, and may never be lighter-stroked than the thing beneath it.
 *
 * Instrument Serif exists as a single 400 master (app/fonts/ has one weight), so
 * `.v4-display` set every heading on the site — the hero, every section H2, every
 * subpage headline via WordsPullUp, and both legal titles — at weight 400 while
 * the card h3s under them stayed sans-600: sub-elements out-weighing the headings
 * above them. `font-weight: 600` on that face is not a fix; the browser
 * synthesizes a smeared bold from the 400 outline.
 *
 * The rule that block pins is the FALLBACK path today: display type is Source
 * Serif 4 (variable 400–700, self-hosted) with the weight RISING as the size
 * falls, and Instrument Serif kept for the ≥1024px landing hero. Since
 * 2026-08-20 that is what a locale the display face cannot set falls back to —
 * today, zh. What an English or French visitor sees is the Bellefair block
 * below, and the two things that make it a different shape of gate:
 *
 *   · Latin-only  → the face is bound by an explicit locale ALLOWLIST, so a
 *     fourth locale added to i18n/routing.ts lands on the Source Serif stack by
 *     default rather than on a face with no glyphs for it.
 *   · ONE MASTER  → there is no heavier cut to step to. The 620/600/580 ladder
 *     does not collapse to a smaller ladder, it collapses to a single weight,
 *     and the only honest compensation left is SIZE. Which rungs needed it was
 *     measured, not guessed — see the ladder block for the numbers and method.
 *
 * And the accent is colour, not slant (founder, 2026-08-19) — then, from
 * 2026-08-20, not colour either: display copy is one colour, and amber is left
 * to the things a reader can act on.
 */

const CSS = readFileSync(fileURLToPath(new URL('./globals.css', import.meta.url)), 'utf8');
const LAYOUT = readFileSync(fileURLToPath(new URL('./[locale]/layout.tsx', import.meta.url)), 'utf8');
const root = postcss.parse(CSS);

/** Split a selector LIST on its top-level commas only. `:where(a, b) c` is one
 * selector containing a comma, so a plain `.split(',')` shreds it into two
 * fragments that match nothing — and a gate that matches nothing passes. */
function selectorList(selector: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of selector) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  out.push(current.trim());
  return out.filter(Boolean).map((s) => s.replace(/\s+/g, ' '));
}

/** Every declaration of `prop` on a rule whose selector list includes `selector`,
 * paired with the `min-width` of the media query it sits in (0 when unqueried). */
function declarations(selector: string, prop: string): { minWidth: number; value: string }[] {
  const found: { minWidth: number; value: string }[] = [];
  root.walkRules((rule) => {
    if (!selectorList(rule.selector).includes(selector)) return;
    let minWidth = 0;
    let parent: postcss.Container | postcss.Document | undefined = rule.parent;
    while (parent) {
      if (parent.type === 'atrule' && (parent as postcss.AtRule).name === 'media') {
        const match = /min-width:\s*(\d+)px/.exec((parent as postcss.AtRule).params);
        if (match?.[1]) minWidth = Math.max(minWidth, Number(match[1]));
      }
      parent = parent.parent;
    }
    rule.walkDecls(prop, (decl) => {
      found.push({ minWidth, value: decl.value.trim() });
    });
  });
  return found;
}

function only(selector: string, prop: string): string {
  const found = declarations(selector, prop);
  expect(found, `${selector} { ${prop} } declared ${found.length} times`).toHaveLength(1);
  return found[0]?.value ?? '';
}

describe('display type is set in a face that ships the weight (SITE-02)', () => {
  it('sets .v4-display in the variable serif, never the 400-only display face', () => {
    expect(only('.v4-display', 'font-family')).toContain('var(--font-serif)');
    expect(only('.v4-display', 'font-family')).not.toContain('--font-serif-display');
  });

  it('steps .v4-display weight DOWN as the viewport (and so the size) grows', () => {
    const weights = declarations('.v4-display', 'font-weight')
      .map((d) => ({ minWidth: d.minWidth, weight: Number(d.value) }))
      .sort((a, b) => a.minWidth - b.minWidth);
    expect(weights).toEqual([
      { minWidth: 0, weight: 620 },
      { minWidth: 640, weight: 600 },
      { minWidth: 1024, weight: 580 },
    ]);
  });

  it('never lets a browser synthesize the weight it asks for', () => {
    expect(only('.v4-display', 'font-synthesis-weight')).toBe('none');
    expect(only('.legal-title', 'font-synthesis-weight')).toBe('none');
  });

  it('gives the legal titles the same section-scale weight, not the 400 hairline', () => {
    expect(only('.legal-title', 'font-family')).toContain('var(--font-serif)');
    expect(Number(only('.legal-title', 'font-weight'))).toBeGreaterThanOrEqual(580);
  });

  it('keeps Instrument Serif for the hero at ≥1024px only', () => {
    // The FALLBACK path's pin, unchanged. Since Bellefair landed this no longer
    // describes an English or French hero — it describes what a locale the
    // display face cannot set falls back to (today: zh).
    const heroFaces = declarations('.v4-hero-h1', 'font-family');
    expect(heroFaces).toHaveLength(1);
    expect(heroFaces[0]?.minWidth).toBe(1024);
    expect(heroFaces[0]?.value).toContain('var(--font-serif-display)');
    const heroWeights = declarations('.v4-hero-h1', 'font-weight')
      .map((d) => ({ minWidth: d.minWidth, weight: Number(d.value) }))
      .sort((a, b) => a.minWidth - b.minWidth);
    expect(heroWeights).toEqual([
      { minWidth: 0, weight: 550 },
      { minWidth: 640, weight: 500 },
      { minWidth: 1024, weight: 400 },
    ]);
  });

  it('carries no shadow behind the display type — and cannot re-add a dead one', () => {
    // The hero declared `text-shadow: light-dark(<shadow>, <shadow>)`. light-dark()
    // is a <color> function, so wrapping a whole shadow LIST in it is invalid and
    // every one of those declarations computed to `none` — probed in Chromium:
    // whole-list wrapped → "none", colour-only → applies. The review asked for
    // LESS blur behind the display type and there was none, so they are gone. This
    // fails if the invalid shape comes back anywhere in the stylesheet.
    expect(declarations('.v4-hero-h1', 'text-shadow')).toEqual([]);
    expect(CSS).not.toMatch(/text-shadow:\s*light-dark\(\s*\d/);
    // Positive control: light-dark() is still used, in the places it is valid.
    expect(CSS).toContain('light-dark(');
  });
});

/**
 * Bellefair — the display face, Latin locales only, ONE master.
 *
 * ── The mechanism is an allowlist ────────────────────────────────────────
 * Every display surface — the hero H1, .v4-display (every section H2 and every
 * subpage headline via WordsPullUp), the three section-scale classes, both legal
 * titles, and the deck under a headline — is re-set for en and fr BY NAME. It is
 * by name because the face is Latin-only: `html:not([lang='zh'])` would fail the
 * other way round, landing a fourth locale on a face with no glyphs for it. So
 * the assertion below is "every rule that names Bellefair is in the allowlist".
 *
 * ── There is no ladder, because there is no second master ────────────────
 * Source Serif is a variable 400–700, so #506 could step it 620 → 600 → 580 as
 * the size grew. Bellefair ships 400 and nothing else. A `font-weight: 700` on
 * it is the exact smear #506 removed, so the gate below pins every weight to 400
 * and `font-synthesis-weight: none` on every surface that names the face.
 *
 * Which leaves SIZE as the only honest compensation, and the size steps below
 * are measured rather than preferred. Two numbers, both read off a Chromium
 * raster of the shipped .woff2 at 1000px rather than off OS/2:
 *
 *   BELLEFAIR_STEM_PER_EM   the vertical stroke of an 'n', 0.064em. Source Serif
 *                           620 is 0.133em and the Instrument Serif 400 that
 *                           #506 REMOVED is 0.068em — so Bellefair 400 is a
 *                           lighter stroke than the face this gate was written
 *                           to keep off the site, and every rung has to be
 *                           re-checked rather than assumed.
 *   SUB_ELEMENT_STEM_PX     the stem of the heaviest Instrument Sans 600
 *                           sub-element inside each rung's own section, read off
 *                           the running site at 390px and 1440px.
 *
 * The rule is #506's own, made physical: a heading's stem, in rendered px, must
 * not be thinner than the stem of the card heading beneath it. Rungs that
 * cleared it at their approved size ship at that size (the hero, at 136% and
 * 287%). Rungs that did not are stepped UP until they clear — never bolded,
 * never mixed with a second family.
 *
 * What a size step CANNOT restore is the 185% margin the variable serif held,
 * and this gate does not pretend otherwise: it pins parity, not the old margin.
 * The rest of the hierarchy is carried by cap height (Bellefair's cap is 0.691em
 * against Source Serif's 0.663em), by colour, and by the card the h3 sits in.
 */
const BELLEFAIR_STEM_PER_EM = 0.064;
const REM = 16;

/** Stem px of the heaviest Instrument Sans 600 sub-element under each rung, and
 * of the body copy a deck leads — measured on the running site, 390 / 1440. */
const FLOOR_PX = {
  landingCardH3: { 390: 2.18, 1440: 2.32 },
  pricingCardH3: { 390: 3.02, 1440: 3.83 },
  aboutCardH3: { 390: 2.32, 1440: 2.32 },
  legalSectionH2: { 390: 2.92, 1440: 3.73 },
  bodyCopy: { 390: 1.34, 1440: 1.34 },
  navLink: { 390: 1.28, 1440: 1.36 },
} as const;

const BELLEFAIR_HEADING_SELECTORS = [
  "html[lang='en'] .v4-display",
  "html[lang='fr'] .v4-display",
  "html[lang='en'] .legal-title",
  "html[lang='fr'] .legal-title",
];
const BELLEFAIR_HERO_SELECTORS = ["html[lang='en'] .v4-hero-h1", "html[lang='fr'] .v4-hero-h1"];
const BELLEFAIR_DECK_SELECTORS = [
  "html[lang='en'] .v4-hero-sub",
  "html[lang='fr'] .v4-hero-sub",
  "html[lang='en'] .v4-lede",
  "html[lang='fr'] .v4-lede",
];
/** Every rule that reaches Bellefair — and since the wordmark became drawn art
 * that is every rule INSIDE the locale allowlist. The mark used to be the one
 * exception, a Latin string on the Chinese page too with no locale for the
 * allowlist to protect; drawing it removed the exception rather than documenting
 * it a second time. See the drawn-mark block at the foot of this file. */
const BELLEFAIR_ALL_SELECTORS = [
  ...BELLEFAIR_HEADING_SELECTORS,
  ...BELLEFAIR_HERO_SELECTORS,
  ...BELLEFAIR_DECK_SELECTORS,
];

/** The `min` of a `clamp(min, preferred, max)`, in px. That is the rung's
 * narrowest rendered size — 390px viewports sit on it — and so the size the
 * stem floor has to be checked against. */
function clampFloorPx(value: string): number {
  const match = /clamp\(\s*([\d.]+)rem/.exec(value);
  expect(match, `not a clamp with a rem floor: ${value}`).not.toBeNull();
  return Number(match?.[1]) * REM;
}

/** The `max` of a `clamp(...)`, in px — what a 1440px viewport resolves to on
 * every display rung on this site (each one's vw term overshoots its ceiling). */
function clampCeilingPx(value: string): number {
  const match = /clamp\([^,]+,[^,]+,\s*([\d.]+)rem\s*\)/.exec(value);
  expect(match, `not a clamp with a rem ceiling: ${value}`).not.toBeNull();
  return Number(match?.[1]) * REM;
}

const stemPx = (sizePx: number) => sizePx * BELLEFAIR_STEM_PER_EM;

describe('the display face is Bellefair (Latin locales only, one master)', () => {
  it('self-hosts the single OFL master and binds it to --font-bellefair', () => {
    expect(LAYOUT).toContain('bellefair-latin-400-normal.woff2');
    expect(LAYOUT).toContain("variable: '--font-bellefair'");
    // Registered is not enough — the variable must reach the document.
    expect(LAYOUT).toContain('bellefair.variable');
  });

  it('registers exactly one weight, because exactly one master exists', () => {
    const registered = [
      ...LAYOUT.matchAll(/bellefair-[\w-]*\.woff2['"],\s*weight:\s*'(\d+)'/g),
    ].map((m) => m[1]);
    expect(registered).toEqual(['400']);
    expect(LAYOUT).not.toMatch(/bellefair-(thin|light|medium|semibold|bold|black|\w*italic)/i);
  });

  it('sets every display surface in Bellefair for en and fr', () => {
    for (const selector of BELLEFAIR_ALL_SELECTORS) {
      expect(only(selector, 'font-family'), selector).toContain('var(--font-bellefair)');
    }
  });

  it('never lets a locale reach Bellefair except through the allowlist', () => {
    const bound: string[] = [];
    root.walkDecls('font-family', (decl) => {
      if (!decl.value.includes('--font-bellefair')) return;
      const selector = (decl.parent as postcss.Rule | undefined)?.selector ?? '';
      bound.push(...selectorList(selector));
    });
    expect(bound.sort()).toEqual([...BELLEFAIR_ALL_SELECTORS].sort());
    // Positive control: the scan does find font-family declarations that are NOT
    // Bellefair, so a matching result above means "correctly scoped", not "the
    // walker found nothing".
    expect(declarations('.v4-display', 'font-family')).toHaveLength(1);
  });

  it('leaves zh on the Source Serif stack — every rule, not just the hero', () => {
    const localeQualified = [...CSS.matchAll(/html\[lang='(\w+)'\]/g)].map((m) => m[1]);
    expect([...new Set(localeQualified)].sort()).toEqual(['en', 'fr']);
  });

  it('asks for weight 400 and nothing else — there is no second master to reach', () => {
    for (const selector of BELLEFAIR_ALL_SELECTORS) {
      for (const { value } of declarations(selector, 'font-weight')) {
        expect(Number(value), `${selector} asks for ${value}`).toBe(400);
      }
    }
  });

  it('never lets a browser fake the weight it does not ship', () => {
    // The whole risk of a single-weight display face: a stray `font-weight: 600`
    // anywhere above these surfaces would be synthesized into the smear #506
    // removed. Every surface that names the face refuses synthesis at the surface.
    for (const selector of BELLEFAIR_ALL_SELECTORS) {
      expect(only(selector, 'font-synthesis-weight'), selector).toBe('none');
    }
  });

  it('mixes no second family into display — the fallback is a system serif, not a face we load', () => {
    for (const selector of BELLEFAIR_ALL_SELECTORS) {
      const stack = only(selector, 'font-family');
      expect(stack, selector).not.toContain('--font-serif');
      expect(stack, selector).not.toContain('--font-sans');
    }
  });

  it('ships the hero at its approved size — 400 already clears the floor there', () => {
    // Hero clamp floors at 2.9rem/46.4px and tops out at 6.5rem/104px, giving a
    // 2.97px stem against the landing card h3's 2.18px (136%) and 6.66px against
    // 2.32px (287%). Nothing to compensate, so nothing is changed: the gate holds
    // the line against a size step nobody measured a need for.
    for (const selector of BELLEFAIR_HERO_SELECTORS) {
      expect(declarations(selector, 'font-size'), `${selector} may not resize`).toEqual([]);
    }
    expect(stemPx(2.9 * REM)).toBeGreaterThanOrEqual(FLOOR_PX.landingCardH3[390]);
    expect(stemPx(6.5 * REM)).toBeGreaterThanOrEqual(FLOOR_PX.landingCardH3[1440]);
  });

  it('steps every rung that measured UNDER its sub-element up until it clears', () => {
    // Each row: the rung, and the stem it has to beat at 390 / 1440. Every one of
    // these measured under 100% at the size it shipped in Source Serif — see the
    // block comment. The assertion is the measurement, not the number: lower a
    // clamp floor and this fails naming the sub-element it would sink under.
    //
    // The two generic rules are wrapped WHOLE in :where(), so each scores zero
    // specificity. That is load-bearing twice over: the base display scale has to
    // LOSE to a named scale (.v4-hero-h1, .v4-h2 and .v4-h2-wide were each
    // measured against a different sub-element), and it still beats the base-layer
    // h1/h2 rules by layer order alone. Wrapping only the locale prefix is not
    // enough — `:where(html[lang='en'], …) h1.v4-display` still scores a class for
    // .v4-display and outranks .v4-hero-h1, which dropped the landing hero from
    // 104px to 76px on the running site while this file stayed green.
    const stepped: [string, keyof typeof FLOOR_PX][] = [
      [":where(html[lang='en'] h1.v4-display, html[lang='fr'] h1.v4-display)", 'pricingCardH3'],
      [":where(html[lang='en'] h2.v4-display, html[lang='fr'] h2.v4-display)", 'aboutCardH3'],
      ["html[lang='en'] .v4-h2", 'landingCardH3'],
      ["html[lang='en'] .v4-h2-wide", 'landingCardH3'],
      ["html[lang='en'] .legal-title", 'legalSectionH2'],
      ["html[lang='en'] .v4-hero-sub", 'bodyCopy'],
      ["html[lang='en'] .v4-lede", 'bodyCopy'],
    ];
    for (const [selector, floor] of stepped) {
      const size = only(selector, 'font-size');
      expect(stemPx(clampFloorPx(size)), `${selector} @390 sinks under ${floor}`).toBeGreaterThanOrEqual(
        FLOOR_PX[floor][390],
      );
      expect(stemPx(clampCeilingPx(size)), `${selector} @1440 sinks under ${floor}`).toBeGreaterThanOrEqual(
        FLOOR_PX[floor][1440],
      );
    }
    // Both locales get the step, or French reads at a size English does not.
    for (const [selector] of stepped) {
      if (selector.startsWith(':where')) continue;
      const fr = selector.replace("lang='en'", "lang='fr'");
      expect(only(fr, 'font-size'), fr).toBe(only(selector, 'font-size'));
    }
  });

  it('leaves the fallback locale on its approved sizes — the step is Bellefair’s, not zh’s', () => {
    // The size compensation exists because Bellefair's stroke is thin and its
    // x-height small. Neither is true of the CJK stack zh falls back to, so the
    // unqualified rules keep the sizes #506 approved. This is why the step lives
    // in the allowlist rather than in the base h1/h2 rules or in a `text-[…]`
    // utility, which no locale rule can reach.
    expect(only('.v4-h2', 'font-size')).toBe('clamp(1.9rem, 4.4vw, 3rem)');
    expect(only('.legal-title', 'font-size')).toBe('clamp(2.2rem, 5vw, 3rem)');
    expect(CSS).toMatch(/h1 \{ font-size: clamp\(2\.6rem, 6vw, 4\.75rem\); \}/);
    expect(CSS).toMatch(/h2 \{ font-size: clamp\(2rem, 4vw, 3\.1rem\); \}/);
    // .v4-h2-wide is the how-it-works headline, which came out of a
    // `text-[clamp(2rem,5vw,3.4rem)]` utility. It had to become a class or the
    // step was unreachable — a utility outranks every layer a locale rule can
    // sit in (probed in Chromium). Its UNQUALIFIED value is the size the utility
    // set, so zh renders exactly what it rendered before the move.
    expect(only('.v4-h2-wide', 'font-size')).toBe('clamp(2rem, 5vw, 3.4rem)');
  });

  it('opens the tracking rather than closing it — a hairline needs its counters', () => {
    // Source Serif tightened to -0.01em and the Instrument Serif hero to -0.015em.
    // Bellefair runs a 1.88:1 contrast with a 0.034em hairline; the same tightening
    // closes the joins. No display rule may track negative.
    for (const selector of [...BELLEFAIR_HEADING_SELECTORS, ...BELLEFAIR_HERO_SELECTORS]) {
      for (const { value } of declarations(selector, 'letter-spacing')) {
        const em = value === 'normal' ? 0 : Number(value.replace('em', ''));
        expect(em, `${selector} tracks ${value}`).toBeGreaterThanOrEqual(0);
      }
    }
    // The deck is running text: never tracked at all.
    for (const selector of BELLEFAIR_DECK_SELECTORS) {
      expect(only(selector, 'letter-spacing')).toBe('normal');
    }
  });

  it('opens the leading past the face’s own ink extent', () => {
    // Measured in Chromium off the shipped woff2: ascender 0.740em + descender
    // 0.239em = 0.979em of ink, against Source Serif's 0.965em and Instrument
    // Serif's 0.955em. The ≥1024px hero ran at 0.96 on Instrument Serif, which
    // Bellefair would OVERLAP. Nothing here may lead under its own ink.
    for (const selector of [...BELLEFAIR_HEADING_SELECTORS, ...BELLEFAIR_HERO_SELECTORS]) {
      for (const { value } of declarations(selector, 'line-height')) {
        expect(Number(value), `${selector} leads at ${value}`).toBeGreaterThan(0.979);
      }
    }
  });

  it('keeps the balanced wrap the display type was built on', () => {
    // Bellefair sets ~27% narrower per lowercase character while its `0` is only
    // ~7% narrower, so the same `ch` box holds a materially longer line.
    // text-wrap: balance is what absorbs that, so it may not be dropped alongside
    // the face change.
    expect(CSS).toMatch(/h1, h2, h3, h4 \{[\s\S]*?text-wrap: balance;[\s\S]*?\}/);
  });

  it('records the one rung that ships UNDER stem parity, rather than hiding it', () => {
    // Honesty pin. The pricing plan card's price is an h3 in Instrument Sans 600
    // at 30.4px — a 3.83px stem, the heaviest sub-element anywhere on the site.
    // The section H2 above those cards would need ~60px to out-stroke it, which
    // is a 5-line headline at the 42rem measure, so it ships at 49.6px / 3.17px:
    // 83% of parity. It is the ONE rung that does.
    //
    // It ships anyway because the price is bounded inside a card, and a container
    // edge subordinates a heading that a bare column does not — which is also why
    // the alternative was worse. Left in the sans it had been, that same H2
    // measured 6.25px and out-stroked the Bellefair page H1 above it (4.86px):
    // two BARE headlines in one column, compared directly, with nothing between
    // them. Trading a contained 83% for an uncontained 78% is the trade this
    // pin records.
    //
    // If the plan card's price ever shrinks, or a heavier display master is ever
    // licensed, this is the rung to revisit.
    const PRICING_H2_STEM_PX = 49.6 * BELLEFAIR_STEM_PER_EM;
    const PLAN_CARD_PRICE_STEM_PX = 30.4 * 0.126;
    expect(PRICING_H2_STEM_PX / PLAN_CARD_PRICE_STEM_PX).toBeLessThan(1);
    expect(PRICING_H2_STEM_PX / PLAN_CARD_PRICE_STEM_PX).toBeGreaterThan(0.8);
    // And it is genuinely the only one: every other rung cleared its floor in the
    // stepped-rung test above, which runs against the same measurements.
    const pricing = readFileSync(
      fileURLToPath(new URL('../components/pricing-section.tsx', import.meta.url)),
      'utf8',
    );
    // It has to be IN the display system for the trade above to hold — as a bare
    // sans h2 it is the uncontained inversion, not the contained one.
    expect(pricing).toContain('<h2 className="v4-display mt-3">');
  });

  it('carries the OFL text beside the binary it licenses', () => {
    const ofl = readFileSync(fileURLToPath(new URL('./fonts/bellefair-OFL.txt', import.meta.url)), 'utf8');
    expect(ofl).toContain('SIL OPEN FONT LICENSE Version 1.1');
    expect(ofl).toContain('Bellefair');
  });
});

/**
 * The wordmark left the type system (2026-08-20).
 *
 * It was the last display surface still set in a font — Bellefair 400 at 1.65rem
 * — and it carried every problem this file exists to police. It was the one rule
 * that had to sit OUTSIDE the locale allowlist. It was the rung the stem gate had
 * to keep stepping UP (1.2rem → 1.65rem) so the name did not read lighter than
 * the nav links beside it. And a stray `font-weight` above it would have been
 * synthesized into the same smear #506 removed. None of those are problems a logo
 * should have, because none of them are problems a logo should be able to have.
 *
 * So the name is drawn once and frozen: components/wordmark.tsx, one traced path
 * from Just Another Hand (Apache-2.0, logo use unrestricted) under the square
 * dilation the founder approved in the comps — reproduced by RATIO (radius/em
 * 0.009375, read back off the comp's own box growth and median stroke) so it is
 * the approved weight rather than merely a heavier one.
 *
 * What that RETIRES, deliberately:
 *
 *   font-family / font-weight / font-synthesis-weight   There is no font. A drawn
 *       path cannot be synthesized into a smear, which is the whole of what those
 *       three pinned. Retired, not relaxed.
 *   letter-spacing   There are no letters to space.
 *   font-size + its stem rung   Kept in SUBSTANCE, dropped in form. The check
 *       below is the same invariant — the name may not read lighter than its own
 *       navigation — measured off the shipped ARTWORK instead of off a face.
 *
 * The constants are measured the way the rest of this file's are: the shipped
 * path rasterised in Chromium at a 1139px box, then read off the raster.
 *
 * And the honest note for whoever edits this next: at 1.32rem the drawn stem is
 * 2.73px against the nav link's 1.36px, so it clears the floor by 2x and would go
 * on clearing it well below any size anyone would ship. Stroke weight is no
 * longer what decides this mark's size. What decides it is the cap beside the
 * 28px LogoMark, which is why that is pinned too.
 */
const WORDMARK_ART = {
  /** Vertical stroke of the 'H', as a fraction of the mark's rendered box height. */
  stemPerBox: 0.129,
  /** Cap height as a fraction of the box — the 'l' descender is the remainder. */
  capPerBox: 0.9517,
  /** The cap the Bellefair mark landed at, which this one may not undercut. */
  typeCapPx: 18.2,
} as const;

describe('the wordmark is drawn art, not set type', () => {
  // Asserted against what SHIPS, not against the component source: the source
  // also talks about the baked fill it removed, and a scan of the prose reads
  // that mention as the thing itself.
  const MARK = renderToStaticMarkup(createElement(Wordmark));
  const pathData = /<path d="([^"]+)"/.exec(MARK)?.[1] ?? '';

  it('ships one path that takes its colour from the cascade', () => {
    // potrace emits `fill="#000000"` and a width/height in points. Shipped as
    // traced, that is a black mark on the navy dark ground, in a box no CSS can
    // resize. Both are removed rather than overridden, so there is nothing left
    // to lose a specificity fight to.
    expect([...MARK.matchAll(/<path\b/g)]).toHaveLength(1);
    expect(MARK).toContain('fill="currentColor"');
    expect(MARK, 'a baked fill cannot follow the theme').not.toMatch(/fill="#/);
    expect(MARK, 'a baked size cannot be re-sized').not.toMatch(/<svg[^>]*\s(width|height)=/);
    expect(MARK).toContain('viewBox="0 0 1498.41 1138.88"');
  });

  it('keeps the art small enough to inline on every page', () => {
    // It is inlined into five lockups on every route, so the path is in the HTML
    // payload of every page. Budget is 8KB; it ships at well under half.
    expect(pathData.length).toBeGreaterThan(500);
    expect(pathData.length).toBeLessThan(8 * 1024);
  });

  it('leaves .wordmark a BOX — every type declaration went with the type', () => {
    for (const prop of ['font-family', 'font-weight', 'font-synthesis-weight', 'font-size', 'letter-spacing']) {
      expect(declarations('.wordmark', prop), `.wordmark still sets ${prop}`).toEqual([]);
    }
    expect(only('.wordmark', 'height')).toBe('1.32rem');
    // Width comes from the art's own aspect ratio; a fixed width would squash it.
    expect(only('.wordmark', 'width')).toBe('auto');
  });

  it('still out-strokes the navigation beside it — the old invariant, new measure', () => {
    const boxPx = Number(/([\d.]+)rem/.exec(only('.wordmark', 'height'))?.[1]) * REM;
    expect(boxPx * WORDMARK_ART.stemPerBox).toBeGreaterThanOrEqual(FLOOR_PX.navLink[1440]);
    // And it may not shrink under the cap the type mark held against the 28px tile.
    expect(boxPx * WORDMARK_ART.capPerBox).toBeGreaterThanOrEqual(WORDMARK_ART.typeCapPx);
  });

  it('draws every "Hale" with the one component — no typed mark left anywhere', () => {
    // Five lockups: the site header, the site footer, the legal masthead, the
    // landing's closing card and the QR-entry page. The legal one was missed when
    // the face last changed and only the running site caught it, so the scan is
    // over the sources rather than over one rendered page.
    const components = [
      'site-header',
      'site-footer',
      'legal-layout',
      'text-entry',
      'landing/v4/landing-v4',
    ].map((name) => readFileSync(fileURLToPath(new URL(`../components/${name}.tsx`, import.meta.url)), 'utf8'));
    const drawn = components.flatMap((source) => [...source.matchAll(/<Wordmark\b/g)]);
    // Positive control: the scan finds all five, so a clean typed-mark result
    // below is not an empty match set — and this fails if a sixth appears.
    expect(drawn).toHaveLength(5);
    for (const source of components) {
      expect([...source.matchAll(/<span[^>]*>\s*Hale\s*<\/span>/g)], 'a typed mark survives').toEqual([]);
    }
  });

  it('never lets decorative art delete the name it replaced', () => {
    // The regression this change could have shipped in silence. Three of the five
    // lockups are an `<a aria-label="Hale, home">`, whose label wins over any
    // descendant text — but the landing's closing card and the QR-entry page are
    // NOT links, and there the visible word was the only "Hale" in the
    // accessibility tree. aria-hidden art alone would have removed it from both
    // while the three anchors carried on naming themselves.
    expect(MARK).toContain('aria-hidden="true"');
    expect(MARK).toContain('<span class="sr-only" translate="no">Hale</span>');
    // Mutation control: the drawing itself says nothing, so the span is the whole
    // of the name rather than a duplicate of one the <svg> also carries.
    const svg = /<svg[\s\S]*?<\/svg>/.exec(MARK)?.[0] ?? '';
    expect(svg).not.toContain('aria-label');
    expect(svg).not.toContain('role="img"');
  });
});

describe('the accent is neither slant nor colour', () => {
  it('has no italic display treatment left in the stylesheet', () => {
    const italicised: string[] = [];
    root.walkDecls('font-style', (decl) => {
      if (decl.value.trim() !== 'italic') return;
      const selector = (decl.parent as postcss.Rule | undefined)?.selector ?? '';
      if (/\.(v4-|legal-title|accent|v3-accent|pull-word|wordmark)/.test(selector)) italicised.push(selector);
    });
    expect(italicised).toEqual([]);
    // Positive control: the scan does see the one italic the site keeps — <em>
    // in body copy, which is prose emphasis and not display type.
    expect(CSS).toContain('em { font-style: italic; }');
  });

  it('renders the accent word in its heading’s own colour', () => {
    // It was amber. Display copy is now ONE colour, and the span survives only so
    // the headline can still be segmented (WordsPullUp, and the landing h1) —
    // `inherit` is the declaration that says the divergence was removed on
    // purpose rather than forgotten, and it holds the line against a utility
    // tinting the span back.
    expect(only('.v4-accent', 'color')).toBe('inherit');
    expect(declarations('.v4-accent', 'font-style')).toEqual([]);
    expect(CSS).not.toContain('v4-italic');
  });

  it('paints no display rule in amber — the mark is left to what a reader can act on', () => {
    const amberDisplay: string[] = [];
    root.walkDecls('color', (decl) => {
      if (!decl.value.includes('--color-amber')) return;
      const selector = (decl.parent as postcss.Rule | undefined)?.selector ?? '';
      if (
        /\.(v4-display|v4-hero-h1|v4-h2|v4-lede|v4-hero-sub|v4-accent|legal-title|pull-word|wordmark)\b/.test(
          selector,
        )
      ) {
        amberDisplay.push(selector);
      }
    });
    expect(amberDisplay).toEqual([]);
    // Positive control: amber is still painted, on the functional elements it was
    // reserved to — the eyebrow label and the CTA/link family.
    expect(only('.v4-eyebrow', 'color')).toBe('var(--color-amber)');
  });

  it('loads no italic master for any display face — nothing sets one', () => {
    expect(LAYOUT).not.toContain("style: 'italic'");
    expect(LAYOUT).not.toContain('-italic.woff2');
    // Positive control: the normal masters are still registered.
    expect(LAYOUT).toContain('source-serif-4-latin-wght-normal.woff2');
    expect(LAYOUT).toContain('instrument-serif-latin-400-normal.woff2');
  });
});
