import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';
import { describe, expect, it } from 'vitest';

/**
 * SITE-02 gate — the display type may never be set in a weight the loaded face
 * does not ship.
 *
 * Instrument Serif exists as a single 400 master (app/fonts/ has one weight), so
 * `.v4-display` set every heading on the site — the hero, every section H2, every
 * subpage headline via WordsPullUp, and both legal titles — at weight 400 while
 * the card h3s under them stayed sans-600: sub-elements out-weighing the headings
 * above them. `font-weight: 600` on that face is not a fix; the browser
 * synthesizes a smeared bold from the 400 outline.
 *
 * The rule this pins: display type is Source Serif 4 (variable 400–700, already
 * self-hosted), and its weight RISES as the size falls, because perceived weight
 * drops with size — <2.5rem → 620, 2.5–4rem → 580–600, ≥4rem → 400–500. Instrument
 * Serif is kept for exactly one thing: the landing hero at ≥1024px, the only place
 * on the site a high-contrast 400 serif renders at ~90–104px.
 *
 * And the accent is colour, not slant (founder, 2026-08-19): no display rule may
 * set `font-style: italic`, and no italic master may be loaded for a display face.
 */

const CSS = readFileSync(fileURLToPath(new URL('./globals.css', import.meta.url)), 'utf8');
const LAYOUT = readFileSync(fileURLToPath(new URL('./[locale]/layout.tsx', import.meta.url)), 'utf8');
const root = postcss.parse(CSS);

/** Every declaration of `prop` on a rule whose selector list includes `selector`,
 * paired with the `min-width` of the media query it sits in (0 when unqueried). */
function declarations(selector: string, prop: string): { minWidth: number; value: string }[] {
  const found: { minWidth: number; value: string }[] = [];
  root.walkRules((rule) => {
    const selectors = rule.selector.split(',').map((s) => s.trim());
    if (!selectors.includes(selector)) return;
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
    const heroFaces = declarations('.v4-hero-h1', 'font-family');
    expect(heroFaces).toHaveLength(1);
    expect(heroFaces[0]?.minWidth).toBe(1024);
    expect(heroFaces[0]?.value).toContain('var(--font-serif-display)');
    // Below that breakpoint the hero inherits .v4-display's Source Serif, at a
    // weight that rises as the 46px mobile floor approaches.
    const heroWeights = declarations('.v4-hero-h1', 'font-weight')
      .map((d) => ({ minWidth: d.minWidth, weight: Number(d.value) }))
      .sort((a, b) => a.minWidth - b.minWidth);
    expect(heroWeights).toEqual([
      { minWidth: 0, weight: 550 },
      { minWidth: 640, weight: 500 },
      { minWidth: 1024, weight: 400 },
    ]);
  });

  it('halves the hero text-shadow blur below the Instrument Serif breakpoint', () => {
    const shadows = declarations('.v4-hero-h1', 'text-shadow').sort(
      (a, b) => a.minWidth - b.minWidth,
    );
    expect(shadows.map((s) => s.minWidth)).toEqual([0, 1024]);
    expect(shadows[0]?.value).toContain('15px');
    expect(shadows[1]?.value).toContain('30px');
  });
});

describe('the accent is colour, not slant', () => {
  it('has no italic display treatment left in the stylesheet', () => {
    const italicised: string[] = [];
    root.walkDecls('font-style', (decl) => {
      if (decl.value.trim() !== 'italic') return;
      const selector = (decl.parent as postcss.Rule | undefined)?.selector ?? '';
      if (/\.(v4-|legal-title|accent|v3-accent|pull-word)/.test(selector)) italicised.push(selector);
    });
    expect(italicised).toEqual([]);
    // Positive control: the scan does see the one italic the site keeps — <em>
    // in body copy, which is prose emphasis and not display type.
    expect(CSS).toContain('em { font-style: italic; }');
  });

  it('paints the accent in amber and nothing else', () => {
    expect(only('.v4-accent', 'color')).toBe('var(--color-amber)');
    expect(declarations('.v4-accent', 'font-style')).toEqual([]);
    expect(CSS).not.toContain('v4-italic');
  });

  it('loads no italic master for either serif — nothing sets one', () => {
    expect(LAYOUT).not.toContain("style: 'italic'");
    expect(LAYOUT).not.toContain('-italic.woff2');
    // Positive control: the normal masters are still registered.
    expect(LAYOUT).toContain('source-serif-4-latin-wght-normal.woff2');
    expect(LAYOUT).toContain('instrument-serif-latin-400-normal.woff2');
  });
});
