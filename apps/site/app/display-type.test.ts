import { readFileSync, readdirSync } from 'node:fs';
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
 * Instrument Serif exists as a single 400 master, so `.v4-display` set every
 * heading on the site at weight 400 while the card h3s under them stayed sans-600:
 * sub-elements out-weighing the headings above them. `font-weight: 600` on that
 * face is not a fix; the browser synthesizes a smeared bold from the 400 outline.
 *
 * Since 2026-08-20 there are three paths through this file, and they are three
 * different SHAPES of gate:
 *
 *   FALLBACK (zh)   Source Serif 4, variable 400–700, weight RISING as the size
 *                   falls, with Instrument Serif kept for the ≥1024px hero. Every
 *                   pin unchanged since #506 — this is what a locale the display
 *                   face cannot set lands on.
 *   BELLEFAIR       ONE master. No heavier cut to reach for, so the only honest
 *                   compensation was SIZE, and #512 stepped five rungs up to buy
 *                   stem parity back. Retired today.
 *   FRAUNCES        Variable in TWO axes (opsz 9–144, wght 100–900), so the
 *                   compensation is WEIGHT again — and the size steps come back
 *                   out. Which is the founder's instruction and also what the
 *                   measurement says: at the 450 the hero is pinned to, every
 *                   rung clears its floor by 154% or better, including the one
 *                   rung #512 had to ship UNDER parity.
 *
 * The face is still bound by an explicit locale ALLOWLIST, because it is still
 * Latin-only: a fourth locale added to i18n/routing.ts must land on the Source
 * Serif fallback rather than on a face with no glyphs for it.
 *
 * And the accent is neither slant (removed 2026-08-19) nor colour (2026-08-20):
 * display copy is one colour, and amber is left to what a reader can act on.
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
    // The FALLBACK path's pin, unchanged: what a locale the display face cannot
    // set falls back to (today: zh).
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
 * Fraunces — the display face, Latin locales only, variable in opsz AND wght.
 *
 * ── What the second axis changes about this gate ─────────────────────────
 * #512's whole difficulty was that Bellefair shipped ONE master: there was no
 * heavier cut, so five rungs bought stem parity with a SIZE step and the file
 * had to pin those steps. Fraunces ships wght 100–900, so the compensation is
 * weight again and every one of those size steps is deleted. The pin that
 * replaces them is stronger than the ones it retires: the locale allowlist may
 * carry NO font-size at all except the hero's, because a size step is now a way
 * of hiding a weight that was never measured.
 *
 * The other axis is why the stem constant below is a TABLE. `opsz` is applied
 * automatically under `font-optical-sizing: auto` — the browser sets it to the
 * rendered font-size in px — and Fraunces uses it hard: the same wght 450 is a
 * 0.1128em stem at opsz 30 and a 0.0997em stem at opsz 84, because the display
 * cut is a higher-contrast drawing. A single STEM_PER_EM would have been wrong
 * by 12% at the two ends of this site's own scale.
 *
 * ── How the numbers were measured ────────────────────────────────────────
 * Same rule as #506 and #512, and the same quantity on both sides of it: a
 * heading's stem, in rendered px, may not be thinner than the stem of the card
 * heading beneath it. What changed is the instrument. #512 read a Chromium
 * raster; this file intersects a horizontal scanline at half the x-height with
 * the flattened 'n' outline of the SHIPPED woff2, instanced at the exact
 * (opsz, wght) the rung renders. The two agree where they overlap — Bellefair
 * 0.0640 against #512's recorded 0.064, Source Serif 620 0.1344 against 0.133,
 * Instrument Sans 600 0.1267 against 0.126 — so the ladder below is comparable
 * to the one it replaces rather than a fresh scale.
 *
 * ── What the measurement said ────────────────────────────────────────────
 * Every rung clears at the 450 the founder pinned the hero to, so every rung
 * ships at 450 and the "step weight UP where the floor demands" instruction
 * demanded no step:
 *
 *   landing hero    5.93px vs 1.93px, 8.37 vs 2.05   → 308% / 408%
 *   subpage H1      4.65 vs 2.68,     7.92 vs 3.39   → 174% / 233%
 *   section H2      3.60 vs 2.05,     5.49 vs 2.05   → 176% / 267%
 *   landing H2      3.43 vs 1.93,     5.33 vs 2.05   → 178% / 260%
 *   how-it-works    3.60 vs 1.93,     5.97 vs 2.05   → 187% / 291%
 *   legal title     3.95 vs 2.59,     5.33 vs 3.30   → 153% / 161%
 *
 * Two of those numbers are the whole argument for the change. The subpage H1 at
 * 390px was 88% of parity in Bellefair and needed a size step to reach 105%; it
 * is 174% here at the size #506 approved. And the pricing section H2 — the ONE
 * rung #512 had to ship under parity, at 83%, with an honesty pin recording the
 * trade — clears at 162%. That pin is deleted because the rung it recorded no
 * longer exists.
 */

/** Stem of an 'n' as a fraction of the em, per (opsz, wght) instance of the
 * shipped woff2. Keyed by the exact pair a rung renders, and `stemPerEm` throws
 * on a pair that is not here: change a clamp and the failure is "nobody measured
 * this size" rather than a silent interpolation between two cuts that are drawn
 * differently. */
const FRAUNCES_STEM_PER_EM: Record<string, number> = {
  '30.4/450': 0.11279,
  '32/450': 0.11263,
  '35.2/450': 0.11233,
  '41.6/450': 0.11171,
  '48/450': 0.111,
  '49.6/450': 0.11069,
  '54/450': 0.10984,
  '54.4/450': 0.10976,
  '76/450': 0.1042,
  '84/450': 0.0997,
  // The lightest cut the face ships, at the narrow end of the two rungs with the
  // heaviest sub-elements. Nothing renders here; it is the mutation control for
  // the floor comparison below.
  '30.4/100': 0.0341,
  '76/100': 0.03032,
};

/** The worst LOWERCASE ink extent, as a fraction of the em, at wght 450 — the
 * tallest ascender over the deepest descender, taken over every rung's own opsz
 * ('b' 0.7388 over 'g' -0.2451 at opsz 30.4; flat to 0.9832 at opsz 84, because
 * Fraunces moves contrast rather than extent).
 *
 * Lowercase, and stated as lowercase, because that is the bound a leading can
 * actually be held to. An accented capital reaches 0.8896em, so É-under-g is
 * 1.1347em and no display leading on any site clears it — that overlap is
 * universal and accepted, and a constant that folded it in would say "these
 * lines can never touch" while meaning something much weaker. */
const FRAUNCES_LOWERCASE_INK_PER_EM = 0.9839;

/** Figtree stem/em, measured the same way — this is the OTHER side of every
 * comparison below, so it has to come off the same instrument. */
const FIGTREE_STEM_PER_EM = { 400: 0.08, 500: 0.0944, 600: 0.1116 } as const;

const REM = 16;

/** Rendered px of the heaviest sub-element under each rung, at 390 / 1440, and
 * the weight it is set in. Sizes are the ones the stylesheet resolves to; the
 * stem is that size times the Figtree cut it is set in. */
const SUB_ELEMENT = {
  /** .v4-card h3 — 1.08rem under the phone-density query, 1.15rem above it. */
  landingCardH3: { 390: 17.28, 1440: 18.4, weight: 600 },
  /** The plan card's price, clamp(1.5rem, 2.6vw, 1.9rem) — the heaviest
   * sub-element anywhere on the site. */
  pricingCardH3: { 390: 24, 1440: 30.4, weight: 600 },
  /** /about's card headings, on the same base h3 rule at both widths. */
  aboutCardH3: { 390: 18.4, 1440: 18.4, weight: 600 },
  /** .legal-section h2, clamp(1.45rem, 3vw, 1.85rem). */
  legalSectionH2: { 390: 23.2, 1440: 29.6, weight: 600 },
  /** .v4-navlink, 0.9rem/500 — the floor the drawn wordmark answers to. */
  navLink: { 390: 14.4, 1440: 14.4, weight: 500 },
} as const;

function floorPx(name: keyof typeof SUB_ELEMENT, width: 390 | 1440): number {
  const sub = SUB_ELEMENT[name];
  return sub[width] * FIGTREE_STEM_PER_EM[sub.weight];
}

function stemPerEm(opsz: number, wght: number): number {
  const measured = FRAUNCES_STEM_PER_EM[`${opsz}/${wght}`];
  expect(measured, `no measurement for Fraunces opsz ${opsz} wght ${wght}`).toBeDefined();
  return measured as number;
}

/** A rung renders at its clamp FLOOR on a 390px viewport (every vw term on this
 * site undershoots there) and at its clamp CEILING on a 1440px one (every vw term
 * overshoots). Both in px — the hero's clamp is stated in px, the rest in rem. */
function clampPx(value: string, end: 'floor' | 'ceiling'): number {
  const parts = /clamp\(([^,]+),[^,]+,([^)]+)\)/.exec(value);
  expect(parts, `not a three-part clamp: ${value}`).not.toBeNull();
  const raw = (end === 'floor' ? parts?.[1] : parts?.[2])?.trim() ?? '';
  const num = Number(raw.replace(/rem|px/, ''));
  return raw.endsWith('rem') ? num * REM : num;
}

/** The one value in the whole gate that is read off nothing: `font-optical-sizing:
 * auto` makes opsz equal the rendered font-size in px, which is what lets a size
 * pick its own row in the stem table. Every Fraunces surface asserts it. */
const opszOf = (renderedPx: number) => renderedPx;

const FRAUNCES_HEADING_SELECTORS = [
  "html[lang='en'] .v4-display",
  "html[lang='fr'] .v4-display",
  "html[lang='en'] .legal-title",
  "html[lang='fr'] .legal-title",
];
const FRAUNCES_HERO_SELECTORS = ["html[lang='en'] .v4-hero-h1", "html[lang='fr'] .v4-hero-h1"];
const FRAUNCES_ALL_SELECTORS = [...FRAUNCES_HEADING_SELECTORS, ...FRAUNCES_HERO_SELECTORS];

/** The base scale a rung resolves to when the allowlist sets no size — which,
 * after this change, is every rung except the hero. */
function baseSize(rule: RegExp): string {
  const match = rule.exec(CSS);
  expect(match, `no base size matching ${rule}`).not.toBeNull();
  return match?.[1] ?? '';
}

describe('the display face is Fraunces (Latin locales only, opsz + wght)', () => {
  it('self-hosts the variable master and binds it to --font-fraunces', () => {
    expect(LAYOUT).toContain('fraunces-latin-opsz-wght-normal.woff2');
    expect(LAYOUT).toContain("variable: '--font-fraunces'");
    // Registered is not enough — the variable must reach the document.
    expect(LAYOUT).toContain('fraunces.variable');
  });

  it('registers the whole weight range, because the whole range is what shipped', () => {
    // The opposite pin to #512's. Bellefair had to be registered as exactly one
    // weight because exactly one master existed; understating Fraunces' range
    // would make next/font declare a narrower @font-face than the file supports
    // and hand the missing weights back to the synthesizer.
    expect(LAYOUT).toMatch(/fraunces-latin-opsz-wght-normal\.woff2['"],\s*weight:\s*'100 900'/);
    expect(LAYOUT).not.toMatch(/fraunces-(thin|light|medium|semibold|bold|black|\w*italic)/i);
  });

  it('retires Bellefair completely — face, registration and binary', () => {
    // Not just unreferenced: gone. An unregistered woff2 left in app/fonts/ is a
    // 13KB invitation for the next person to re-bind the face this change
    // replaced, and its licence text implies a face the site still ships.
    //
    // Scoped to the BINDINGS rather than the word: both files still explain what
    // the face was and why it constrained the gate the way it did, and a scan
    // that cannot tell a live rule from its own history forces that explanation
    // out to keep itself green.
    for (const source of [CSS, LAYOUT]) {
      expect(source).not.toContain('--font-bellefair');
      expect(source).not.toContain('"Bellefair"');
      expect(source).not.toMatch(/bellefair-[\w-]*\.woff2/);
    }
    const shipped = readdirSync(fileURLToPath(new URL('./fonts', import.meta.url)));
    expect(shipped.filter((f) => /bellefair/i.test(f))).toEqual([]);
    // Positive control: the directory listing is real, and the two new binaries
    // are in it beside the three the zh fallback ladder still needs.
    expect(shipped.sort()).toEqual([
      'figtree-OFL.txt',
      'figtree-latin-wght-normal.woff2',
      'fraunces-OFL.txt',
      'fraunces-latin-opsz-wght-normal.woff2',
      'instrument-serif-latin-400-normal.woff2',
      'jetbrains-mono-latin-wght-normal.woff2',
      'source-serif-4-latin-wght-normal.woff2',
    ]);
  });

  it('sets every display surface in Fraunces for en and fr', () => {
    for (const selector of FRAUNCES_ALL_SELECTORS) {
      expect(only(selector, 'font-family'), selector).toContain('var(--font-fraunces)');
    }
  });

  it('never lets a locale reach Fraunces except through the allowlist', () => {
    const bound: string[] = [];
    root.walkDecls('font-family', (decl) => {
      if (!decl.value.includes('--font-fraunces')) return;
      const selector = (decl.parent as postcss.Rule | undefined)?.selector ?? '';
      bound.push(...selectorList(selector));
    });
    expect(bound.sort()).toEqual([...FRAUNCES_ALL_SELECTORS].sort());
    // Positive control: the scan does find font-family declarations that are NOT
    // Fraunces, so a matching result above means "correctly scoped", not "the
    // walker found nothing".
    expect(declarations('.v4-display', 'font-family')).toHaveLength(1);
  });

  it('leaves zh on the Source Serif stack — every rule, not just the hero', () => {
    const localeQualified = [...CSS.matchAll(/html\[lang='(\w+)'\]/g)].map((m) => m[1]);
    expect([...new Set(localeQualified)].sort()).toEqual(['en', 'fr']);
  });

  it('asks opsz to follow the rendered size, on every surface that names the face', () => {
    // Load-bearing for the whole stem table below: without this the browser
    // renders every rung at the 9pt cut's drawing, and a table keyed by rendered
    // px describes a page that does not exist.
    for (const selector of FRAUNCES_ALL_SELECTORS) {
      expect(only(selector, 'font-optical-sizing'), selector).toBe('auto');
    }
  });

  it('never lets a browser fake a weight the axis could have given it', () => {
    for (const selector of FRAUNCES_ALL_SELECTORS) {
      expect(only(selector, 'font-synthesis-weight'), selector).toBe('none');
      const weight = Number(only(selector, 'font-weight'));
      expect(weight, `${selector} asks for ${weight}`).toBeGreaterThanOrEqual(100);
      expect(weight, `${selector} asks for ${weight}`).toBeLessThanOrEqual(900);
    }
  });

  it('mixes no second family into display — the fallback is a system serif, not a face we load', () => {
    for (const selector of FRAUNCES_ALL_SELECTORS) {
      const stack = only(selector, 'font-family');
      expect(stack, selector).not.toContain('--font-serif');
      expect(stack, selector).not.toContain('--font-sans');
    }
  });

  it('ships the hero at the founder’s poster values', () => {
    for (const selector of FRAUNCES_HERO_SELECTORS) {
      expect(only(selector, 'font-size')).toBe('clamp(54px, 8vw, 84px)');
      expect(Number(only(selector, 'font-weight'))).toBe(450);
      expect(only(selector, 'letter-spacing')).toBe('-0.035em');
      expect(only(selector, 'line-height')).toBe('0.95');
    }
  });

  it('carries the face change in WEIGHT — the allowlist sets no size but the hero’s', () => {
    // #512's five size steps, deleted. A rung that measures light now has an axis
    // to answer with, and a size step would be a way of shipping a weight nobody
    // measured. This also puts en/fr and zh back on one scale.
    const sized: string[] = [];
    root.walkDecls('font-size', (decl) => {
      const selector = (decl.parent as postcss.Rule | undefined)?.selector ?? '';
      if (selector.includes("lang='en'") || selector.includes("lang='fr'")) {
        sized.push(...selectorList(selector));
      }
    });
    expect(sized.sort()).toEqual([...FRAUNCES_HERO_SELECTORS].sort());
    // Positive control: the walker does see font-size declarations generally.
    expect(declarations('.v4-h2', 'font-size')).toHaveLength(1);
  });

  it('clears the sub-element beneath it at every rung, at 390 and at 1440', () => {
    // #506's rule, made physical, on both faces at once: the heading's stem in
    // rendered px against the stem of the heaviest thing under it. Lower a clamp
    // or lighten a weight and the failure names the element the rung sinks under.
    const headingWeight = Number(only(FRAUNCES_HEADING_SELECTORS[0] as string, 'font-weight'));
    const heroWeight = Number(only(FRAUNCES_HERO_SELECTORS[0] as string, 'font-weight'));
    const rungs: { label: string; size: string; weight: number; floor: keyof typeof SUB_ELEMENT }[] = [
      {
        label: 'landing hero',
        size: only(FRAUNCES_HERO_SELECTORS[0] as string, 'font-size'),
        weight: heroWeight,
        floor: 'landingCardH3',
      },
      {
        label: 'subpage H1',
        size: baseSize(/h1 \{ font-size: (clamp\([^)]*\)); \}/),
        weight: headingWeight,
        floor: 'pricingCardH3',
      },
      {
        label: 'section H2',
        size: baseSize(/h2 \{ font-size: (clamp\([^)]*\)); \}/),
        weight: headingWeight,
        floor: 'aboutCardH3',
      },
      { label: 'landing H2', size: only('.v4-h2', 'font-size'), weight: headingWeight, floor: 'landingCardH3' },
      {
        label: 'how-it-works H2',
        size: only('.v4-h2-wide', 'font-size'),
        weight: headingWeight,
        floor: 'landingCardH3',
      },
      {
        label: 'legal title',
        size: only('.legal-title', 'font-size'),
        weight: headingWeight,
        floor: 'legalSectionH2',
      },
    ];
    for (const rung of rungs) {
      for (const [width, end] of [
        [390, 'floor'],
        [1440, 'ceiling'],
      ] as const) {
        const px = clampPx(rung.size, end);
        const stem = px * stemPerEm(opszOf(px), rung.weight);
        expect(stem, `${rung.label} @${width} sinks under ${rung.floor}`).toBeGreaterThanOrEqual(
          floorPx(rung.floor, width),
        );
      }
    }
    // Mutation control: the comparison can fail, at both ends of the scale. At
    // the lightest cut the face ships, the landing H2 sinks under its card
    // heading at 390 and the subpage H1 sinks under the plan card's price at
    // 1440 — so a green run above means "measured and clear", not "nothing
    // compared". Chosen at the narrow end of each rung on purpose: at 84px even
    // wght 100 out-strokes a card h3, which is exactly why the check has to be
    // per-rung rather than one global assertion about the face.
    expect(30.4 * stemPerEm(30.4, 100)).toBeLessThan(floorPx('landingCardH3', 390));
    expect(76 * stemPerEm(76, 100)).toBeLessThan(floorPx('pricingCardH3', 1440));
  });

  it('records that the pricing section H2 no longer ships under parity', () => {
    // #512's honesty pin, inverted. The plan card's price is the heaviest
    // sub-element on the site, and against a single-weight display face the
    // section H2 above those cards could only reach 83% of its stem — it shipped
    // under parity with a comment explaining the trade. The same rung, same size,
    // on a face with a weight axis: 162%. The trade is gone, so the pin that
    // recorded it is gone with it, and this is what replaces it.
    const size = clampPx(baseSize(/h2 \{ font-size: (clamp\([^)]*\)); \}/), 'ceiling');
    const h2Stem = size * stemPerEm(opszOf(size), 450);
    expect(h2Stem / floorPx('pricingCardH3', 1440)).toBeGreaterThan(1);
    // It has to be IN the display system for that to mean anything — as a bare
    // sans h2 it is the uncontained inversion #512 was choosing between.
    const pricing = readFileSync(
      fileURLToPath(new URL('../components/pricing-section.tsx', import.meta.url)),
      'utf8',
    );
    expect(pricing).toContain('<h2 className="v4-display mt-3">');
  });

  it('tightens the tracking as the size grows, and never past the hero', () => {
    // Bellefair ran a 0.034em hairline and had to be OPENED (`letter-spacing:
    // normal`) or the joins closed. Fraunces at 450 carries three times that ink,
    // so display tracking is negative again — but the hero is the largest thing
    // on the site and therefore the tightest, and no smaller rung may out-tighten
    // it.
    const hero = Number(only(FRAUNCES_HERO_SELECTORS[0] as string, 'letter-spacing').replace('em', ''));
    expect(hero).toBeLessThan(0);
    for (const selector of FRAUNCES_HEADING_SELECTORS) {
      const em = Number(only(selector, 'letter-spacing').replace('em', ''));
      expect(em, `${selector} tracks looser than 0`).toBeLessThan(0);
      expect(em, `${selector} out-tightens the hero`).toBeGreaterThan(hero);
    }
  });

  it('opens the leading past the face’s own lowercase ink — except where the founder pinned it', () => {
    // The heading rungs lead over the worst lowercase pair by 0.056em, so no
    // wrapped headline in en or fr can touch itself on lowercase alone.
    for (const selector of FRAUNCES_HEADING_SELECTORS) {
      expect(Number(only(selector, 'line-height')), selector).toBeGreaterThan(
        FRAUNCES_LOWERCASE_INK_PER_EM,
      );
    }
    // The hero does NOT, and that is a deliberate founder value rather than an
    // oversight — so it is recorded with the number rather than left unstated.
    // 0.95 against 0.9839em is a 0.0339em overlap, 2.84px at the 84px ceiling,
    // and only reachable where a descender sits directly over a TALL ascender.
    // The real stacks are nowhere near it: measured on the shipped outlines at
    // opsz 84, the English hero's 'y' over 't' clears by 13.5px and its 'y' over
    // 'a' by 21.3px, because 't' is 0.55em where 'b' is 0.74em. A poster headline
    // leads tighter than a page of them; this pin holds the line at 0.95 so it
    // cannot drift tighter, and bounds the overlap it costs.
    expect(Number(only(FRAUNCES_HERO_SELECTORS[0] as string, 'line-height'))).toBe(0.95);
    expect(FRAUNCES_LOWERCASE_INK_PER_EM - 0.95).toBeLessThan(0.035);
  });

  it('keeps the balanced wrap the display type was built on', () => {
    expect(CSS).toMatch(/h1, h2, h3, h4 \{[\s\S]*?text-wrap: balance;[\s\S]*?\}/);
  });

  it('carries the OFL text beside each binary it licenses', () => {
    for (const [file, family] of [
      ['fraunces-OFL.txt', 'Fraunces'],
      ['figtree-OFL.txt', 'Figtree'],
    ]) {
      const ofl = readFileSync(fileURLToPath(new URL(`./fonts/${file}`, import.meta.url)), 'utf8');
      expect(ofl, file).toContain('SIL OPEN FONT LICENSE Version 1.1');
      expect(ofl, file).toContain(family as string);
    }
  });
});

/**
 * Figtree — the body and UI face, replacing Instrument Sans at its registration
 * seam (--font-sans, and so --font-body and --font-display through it).
 *
 * It is a lighter drawing than the face it replaces at the same nominal weight —
 * 0.1116em against 0.1267em at 600 — which is why every floor in the block above
 * had to be recomputed rather than carried over. It is also the reason the hero
 * DECK left the display system: at 16px a serif deck under a serif headline was
 * two settings of one face, and the founder wants the description to read as a
 * different voice from the headline. It is body copy now, in the body face, and
 * the deck's own stem floor is retired with it.
 */
describe('the body and UI face is Figtree', () => {
  it('self-hosts the variable master and binds it to --font-sans', () => {
    expect(LAYOUT).toContain('figtree-latin-wght-normal.woff2');
    expect(LAYOUT).toContain("variable: '--font-sans'");
    expect(LAYOUT).toContain('figtree.variable');
    expect(LAYOUT).toMatch(/figtree-latin-wght-normal\.woff2['"],\s*weight:\s*'300 900'/);
  });

  it('retires Instrument Sans from the site entirely', () => {
    expect(LAYOUT).not.toMatch(/instrument-sans/i);
    expect(CSS).not.toMatch(/"Instrument Sans"/);
    // Positive control: the sans slot is still bound, to the face that replaced it.
    expect(CSS).toMatch(/--font-sans:\s*"Figtree"/);
  });

  it('sets body copy at 400 and the interactive chrome at 500–600', () => {
    expect(CSS).toMatch(/body \{[\s\S]*?font-weight: 400;[\s\S]*?\}/);
    for (const selector of ['.v4-navlink', '.v4-bubble', '.v4-chip']) {
      const weight = Number(only(selector, 'font-weight'));
      expect(weight, `${selector} asks for ${weight}`).toBeGreaterThanOrEqual(500);
      expect(weight, `${selector} asks for ${weight}`).toBeLessThanOrEqual(600);
    }
    for (const selector of ['.v4-btn', '.v4-btn-solid']) {
      const weight = Number(only(selector, 'font-weight'));
      expect(weight, `${selector} asks for ${weight}`).toBeGreaterThanOrEqual(500);
      expect(weight, `${selector} asks for ${weight}`).toBeLessThanOrEqual(600);
    }
  });

  it('puts the hero deck in the body face, not the display one', () => {
    // The founder's distinction, as a scan rather than a description: no rule
    // anywhere binds the display face to the deck, and the deck declares no
    // family of its own, so it inherits --font-body from <html>.
    for (const selector of ['.v4-hero-sub', '.v4-lede']) {
      expect(declarations(selector, 'font-family'), selector).toEqual([]);
      expect(declarations(`html[lang='en'] ${selector}`, 'font-family'), selector).toEqual([]);
      expect(declarations(`html[lang='en'] ${selector}`, 'font-size'), selector).toEqual([]);
    }
    // Positive control: <html> is what supplies the family they inherit.
    expect(CSS).toMatch(/html \{[\s\S]*?font-family: var\(--font-body\);[\s\S]*?\}/);
  });
});

/**
 * The wordmark left the type system (2026-08-20).
 *
 * It was the last display surface still set in a font, and it carried every
 * problem this file exists to police: the one rule outside the locale allowlist,
 * the rung the stem gate kept stepping UP so the name did not read lighter than
 * the nav links beside it, and a stray `font-weight` above it that a single-master
 * face would have smeared. None of those are problems a logo should be able to
 * have, so the name is drawn once and frozen: components/wordmark.tsx, one traced
 * path from Just Another Hand (Apache-2.0, logo use unrestricted).
 *
 * That RETIRES font-family, font-weight, font-synthesis-weight and letter-spacing
 * — there is no font — and keeps the size rung in substance: the check below is
 * the same invariant, the name may not read lighter than its own navigation,
 * measured off the shipped ARTWORK instead of off a face. The face change under
 * it moves only the floor: the nav link is Figtree 500 now, not Instrument Sans.
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
    expect([...MARK.matchAll(/<path\b/g)]).toHaveLength(1);
    expect(MARK).toContain('fill="currentColor"');
    expect(MARK, 'a baked fill cannot follow the theme').not.toMatch(/fill="#/);
    expect(MARK, 'a baked size cannot be re-sized').not.toMatch(/<svg[^>]*\s(width|height)=/);
    expect(MARK).toContain('viewBox="0 0 1498.41 1138.88"');
  });

  it('keeps the art small enough to inline on every page', () => {
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
    expect(boxPx * WORDMARK_ART.stemPerBox).toBeGreaterThanOrEqual(floorPx('navLink', 1440));
    // And it may not shrink under the cap the type mark held against the 28px tile.
    expect(boxPx * WORDMARK_ART.capPerBox).toBeGreaterThanOrEqual(WORDMARK_ART.typeCapPx);
  });

  it('draws every "Hale" with the one component — no typed mark left anywhere', () => {
    const components = [
      'site-header',
      'site-footer',
      'legal-layout',
      'text-entry',
      'landing/v4/landing-v4',
    ].map((name) => readFileSync(fileURLToPath(new URL(`../components/${name}.tsx`, import.meta.url)), 'utf8'));
    const drawn = components.flatMap((source) => [...source.matchAll(/<Wordmark\b/g)]);
    expect(drawn).toHaveLength(5);
    for (const source of components) {
      expect([...source.matchAll(/<span[^>]*>\s*Hale\s*<\/span>/g)], 'a typed mark survives').toEqual([]);
    }
  });

  it('never lets decorative art delete the name it replaced', () => {
    expect(MARK).toContain('aria-hidden="true"');
    expect(MARK).toContain('<span class="sr-only" translate="no">Hale</span>');
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

  it('loads no italic master for any face', () => {
    expect(LAYOUT).not.toContain("style: 'italic'");
    expect(LAYOUT).not.toContain('-italic.woff2');
    // Positive control: the normal masters are still registered, the zh fallback
    // ladder included.
    expect(LAYOUT).toContain('source-serif-4-latin-wght-normal.woff2');
    expect(LAYOUT).toContain('instrument-serif-latin-400-normal.woff2');
  });
});

describe('the pronunciation line is quieter than the labels that share its style', () => {
  it('drops 15–20% of its size, and none of its contrast', () => {
    // The founder asked for it quieter by 15–20%, in size and/or contrast.
    // Contrast was not available: amber measures 4.6:1 on the page in light, which
    // is 0.1 over the AA floor for normal text, so any tint at all would have
    // bought the quiet by making the line inaccessible. So the whole reduction is
    // size, and the colour is asserted to be untouched rather than left unstated.
    const eyebrow = Number(only('.v4-eyebrow', 'font-size').replace('rem', ''));
    const pronounce = Number(only('.v4-pronounce', 'font-size').replace('rem', ''));
    expect(pronounce / eyebrow).toBeLessThanOrEqual(0.85);
    expect(pronounce / eyebrow).toBeGreaterThanOrEqual(0.8);
    expect(declarations('.v4-pronounce', 'color')).toEqual([]);
    expect(declarations('.v4-pronounce', 'opacity')).toEqual([]);
  });

  it('quiets the pronunciation only — every other eyebrow keeps its size', () => {
    // The class exists so the reduction lands on the one line the founder named.
    // A change to .v4-eyebrow itself would have shrunk the seven section labels
    // that carry the page's structure.
    const landing = readFileSync(
      fileURLToPath(new URL('../components/landing/v4/landing-v4.tsx', import.meta.url)),
      'utf8',
    );
    expect([...landing.matchAll(/v4-pronounce/g)]).toHaveLength(1);
    expect([...landing.matchAll(/className="v4-eyebrow/g)].length).toBeGreaterThanOrEqual(5);
  });
});
