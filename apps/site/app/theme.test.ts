import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';
import { describe, expect, it } from 'vitest';
import { NO_FLASH_SCRIPT, THEME_COLOR, THEME_STORAGE_KEY } from '~/lib/site/theme.js';

/**
 * The site's theme system — ONE ladder, every page.
 *
 * #463 shipped the navy dark mode scoped to a `.v3-theme` wrapper on the landing,
 * which left eight subpages light-only: the fork the founder found. The pins here
 * are the ones that make that shape unavailable again. A token cannot be given a
 * light value without its dark half beside it (they are one `light-dark()`
 * declaration), and no `prefers-color-scheme` block may re-point a palette token
 * for a subtree — which is exactly how the scoping was done.
 *
 * The AA assertions on the dark ladder came from app/landing.test.ts, where they
 * guarded one page. They guard the whole site from here.
 */

function globalsCss(): string {
  return readFileSync(fileURLToPath(new URL('./globals.css', import.meta.url)), 'utf8');
}

/** Splits `a, b` at the ONE top-level comma, so `rgb(1 2 3 / .4)` survives. */
function splitPair(inner: string): [string, string] {
  let depth = 0;
  for (let i = 0; i < inner.length; i += 1) {
    const c = inner[i];
    if (c === '(') depth += 1;
    else if (c === ')') depth -= 1;
    else if (c === ',' && depth === 0) {
      return [inner.slice(0, i).trim(), inner.slice(i + 1).trim()];
    }
  }
  throw new Error(`not a light-dark() pair: ${inner}`);
}

/** The two halves of a token's `light-dark(light, dark)` declaration. */
function pair(name: string): { light: string; dark: string } {
  const found = new RegExp(`\\${name}:\\s*light-dark\\(([\\s\\S]*?)\\);`).exec(globalsCss())?.[1];
  if (!found) throw new Error(`${name} is not declared as a light-dark() pair`);
  const [light, dark] = splitPair(found);
  return { light, dark };
}

const darkToken = (name: string) => pair(name).dark;

function hex(value: string): [number, number, number] {
  const s = value.replace('#', '');
  return [0, 2, 4].map((i) => Number.parseInt(s.slice(i, i + 2), 16)) as [number, number, number];
}

function luminance(value: string): number {
  const channel = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = hex(value);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: string, b: string): number {
  const hi = Math.max(luminance(a), luminance(b));
  const lo = Math.min(luminance(a), luminance(b));
  return (hi + 0.05) / (lo + 0.05);
}

describe('theme mechanism — one switch, no page left behind', () => {
  it('follows the OS by default and lets an explicit choice win in BOTH directions', () => {
    const css = globalsCss();
    // `light dark` is what makes every light-dark() pair track prefers-color-scheme
    // with no JavaScript at all — the reason the pre-paint script only has to
    // write overrides.
    expect(css).toMatch(/:root\s*\{\s*color-scheme:\s*light dark;\s*\}/);
    // Both overrides, or the switch is one-way: a reader on a dark machine could
    // not choose light back.
    expect(css).toMatch(/:root\[data-theme="light"\]\s*\{\s*color-scheme:\s*light;\s*\}/);
    expect(css).toMatch(/:root\[data-theme="dark"\]\s*\{\s*color-scheme:\s*dark;\s*\}/);
  });

  it('re-points no palette token inside a prefers-color-scheme block — the fork shape', () => {
    // #463's dark mode WAS a `@media (prefers-color-scheme: dark) { .v3-theme { … } }`
    // block re-declaring --color-*. Because it named a wrapper class, promoting a
    // page into dark meant remembering to wrap it, and eight pages were not. A
    // token pair cannot be forgotten; a wrapper can.
    const offenders: string[] = [];
    postcss.parse(globalsCss()).walkAtRules('media', (rule) => {
      if (!rule.params.includes('prefers-color-scheme') || !rule.params.includes('dark')) return;
      rule.walkDecls((decl) => {
        if (decl.prop.startsWith('--color') || decl.prop.startsWith('--v3-')) {
          offenders.push(`${decl.parent?.toString().split('{')[0]?.trim()} → ${decl.prop}`);
        }
      });
    });
    expect(offenders).toEqual([]);

    // Positive control: the pairs really are being declared somewhere, so the
    // empty list above means "not in a media query" rather than "no dark mode".
    expect([...globalsCss().matchAll(/light-dark\(/g)].length).toBeGreaterThan(25);
  });

  it('leaves no landing-scoped theme wrapper behind', () => {
    // The class the fork lived on. Its `v3-` SIBLINGS (the hero kit) stay.
    expect(globalsCss()).not.toMatch(/\.v3-theme\s*[,{]/);
  });

  it('writes the override before first paint, from the one storage key', () => {
    expect(NO_FLASH_SCRIPT).toContain(JSON.stringify(THEME_STORAGE_KEY));
    expect(NO_FLASH_SCRIPT).toContain('setAttribute("data-theme"');
    // `system` is the ABSENCE of the attribute — anything else would pin a
    // resolved theme into the DOM and stop the OS switch from being followed.
    expect(NO_FLASH_SCRIPT).toContain('removeAttribute("data-theme")');
    expect(NO_FLASH_SCRIPT).not.toContain('"system"');
  });

  it('keeps the browser-chrome colour on the real page ground in each theme', () => {
    expect(THEME_COLOR.light.toLowerCase()).toBe(pair('--color-linen').light);
    expect(THEME_COLOR.dark.toLowerCase()).toBe(pair('--color-linen').dark);
  });
});

describe('the dark ladder is Hale navy, everywhere', () => {
  it('grounds dark mode in Prussian navy rather than a neutral dark', () => {
    // The founder's rule: dark must read navy, not black. Derived from the brand
    // navy #17294A — the ground is the deepest step of that hue and the card IS
    // the brand navy. Pinned as the hue relationship rather than one hex so a
    // retune stays possible and a slide back to the charcoal ladder this replaced
    // (#14120E, where blue was the SMALLEST channel) cannot.
    const ground = darkToken('--color-linen');
    const [r, g, b] = hex(ground);
    expect(b, `${ground} must be blue-dominant`).toBeGreaterThan(g);
    expect(g, `${ground} must be blue-dominant`).toBeGreaterThan(r);
    expect(b - r, `${ground} must be saturated navy, not a neutral dark`).toBeGreaterThanOrEqual(
      28,
    );
    expect(luminance(ground), `${ground} must still be a dark ground`).toBeLessThan(0.02);
    expect(darkToken('--color-oat')).toBe('#17294a');
    expect(darkToken('--color-page')).toBe(ground);
  });

  it('keeps every dark ink step above AA on the lightest surface it lands on', () => {
    // The card (--color-oat) is the lightest ground any body or meta text sits on,
    // so it is the binding constraint for the whole ladder.
    const card = darkToken('--color-oat');
    expect(contrast(darkToken('--color-spruce'), card)).toBeGreaterThanOrEqual(7);
    expect(contrast(darkToken('--color-slate-green'), card)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(darkToken('--color-faded-sage'), card)).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps amber a mark, never an ink that cannot carry the job', () => {
    // #B26B1F is 4.12:1 on the navy ground and 3.45:1 on the card — below AA in
    // both places — so dark swaps in the lighter amber for the caret, the accent
    // halo and the focus ring. The light theme keeps #B26B1F.
    const amber = darkToken('--color-amber');
    expect(pair('--color-amber').light).toBe('#b26b1f');
    expect(amber).not.toBe('#b26b1f');
    expect(contrast(amber, darkToken('--color-oat'))).toBeGreaterThanOrEqual(4.5);
    expect(darkToken('--color-apricot-deep')).toBe(amber);
    // The #FEF0C7 wash cannot survive on navy under cream ink, so it becomes a
    // low-alpha amber that composites over whichever navy is behind it — and the
    // hairline it loses is handed to --color-amber-ring.
    expect(darkToken('--color-apricot-tint')).toMatch(/^rgb\(.*\/\s*0?\.\d+\)$/);
    expect(pair('--color-amber-ring').light).toBe('transparent');
    expect(darkToken('--color-amber-ring')).toMatch(/^rgb\(226 167 90/);
    for (const surface of ['.pill-apricot', '.panel-apricot-tint', '.pill-eyebrow']) {
      const rule = new RegExp(`\\${surface}\\s*\\{[^}]*var\\(--color-amber-ring\\)`);
      expect(rule.test(globalsCss()), `${surface} must wear the amber ring`).toBe(true);
    }
  });

  it('lifts the illustration kit off the navy it would otherwise vanish into', () => {
    // The kit paints houses and turtles from these tokens on /about and /contact.
    // In dark the CARD is #17294a, so a figure still drawn in brand navy is a
    // navy roof on a navy house — invisible, and the exact break a landing-only
    // dark mode never had to face.
    for (const token of ['--color-sea', '--color-sky-deep']) {
      expect(
        contrast(darkToken(token), darkToken('--color-oat')),
        `${token} must separate from the card it is drawn on`,
      ).toBeGreaterThanOrEqual(3);
    }
    // The pricing check-mark, on the same reasoning.
    expect(contrast(darkToken('--color-sage'), darkToken('--color-oat'))).toBeGreaterThanOrEqual(3);
  });

  it('closes the shore band on the page ground, so the night is continuous', () => {
    // The art's own edges are #051C3B–#081E3D. In dark the band takes the page
    // ground, which dissolves the 28px card corners; in light it stays its own
    // statement night against the warm page.
    expect(darkToken('--v3-shore-ground')).toBe(darkToken('--color-linen'));
    expect(pair('--v3-shore-ground').light).toBe('#0c1424');
    expect(globalsCss()).toContain('background: var(--v3-shore-ground);');
  });
});
