import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';
import { describe, expect, it } from 'vitest';

/**
 * WEB-TYPE gate — the authed app is set in the same two faces as the site.
 *
 * apps/site and apps/web are one product with one identity, and a reader crosses
 * between them mid-task (a marketing CTA lands on /sign-in). They had drifted to
 * different type: the site moved to Fraunces + Figtree while the app stayed on
 * Source Serif 4 + Instrument Sans. This file is the pin that keeps the app on the
 * site's faces, and it polices the two things a face swap gets wrong:
 *
 *   THE WEIGHT IS NOT THE OLD WEIGHT. The app's headings were 600 in a text serif.
 *   Fraunces is a display cut with a two-axis (opsz 9–144, wght 100–900) master, and
 *   the founder pinned the hero class at 450. A rung that keeps 600 out of momentum
 *   is not the same drawing, so the ladder below is asserted rung by rung.
 *
 *   A SMALLER RUNG NEEDS MORE STEM, NOT LESS. The app sets headings far smaller than
 *   the site does — the authed stage tops out at 34px against the site's 84px hero —
 *   and a display serif at 450 goes thin there. So the invariant is not a list of
 *   magic numbers but an ordering: weight may never step DOWN as the rendered size
 *   falls. That fails if someone lightens a small rung, which is the actual mistake.
 *
 * Everything here reads the shipped source (globals.css, layout.tsx, app/fonts/) —
 * there is no second copy of these numbers to drift against.
 */

const CSS = readFileSync(fileURLToPath(new URL('./globals.css', import.meta.url)), 'utf8');
const LAYOUT = readFileSync(fileURLToPath(new URL('./layout.tsx', import.meta.url)), 'utf8');
const FONT_DIR = fileURLToPath(new URL('./fonts', import.meta.url));
const root = postcss.parse(CSS);

const REM = 16;

/** Split a selector LIST on its top-level commas only. `:where(a, b) c` is one
 * selector containing a comma, so a plain `.split(',')` shreds it into fragments
 * that match nothing — and a gate that matches nothing passes. */
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
 * in source order. */
function declarations(selector: string, prop: string): string[] {
  const found: string[] = [];
  root.walkRules((rule) => {
    if (!selectorList(rule.selector).includes(selector)) return;
    rule.walkDecls(prop, (decl) => found.push(decl.value.trim()));
  });
  return found;
}

function only(selector: string, prop: string): string {
  const found = declarations(selector, prop);
  expect(found, `${selector} { ${prop} } declared ${found.length} times`).toHaveLength(1);
  return found[0] as string;
}

/** A `@theme` custom property — Tailwind v4's token block, which is where the five
 * font handles live rather than in a `:root` rule. */
function themeToken(prop: string): string {
  const found: string[] = [];
  root.walkAtRules('theme', (at) => {
    at.walkDecls(prop, (decl) => found.push(decl.value.trim()));
  });
  expect(found, `@theme { ${prop} } declared ${found.length} times`).toHaveLength(1);
  return found[0] as string;
}

/** What the rung actually renders in. `h3` carries the shared ladder's weight AND
 * its own override, so the effective value is the last one the cascade sees. */
function weightOf(selector: string): number {
  const found = declarations(selector, 'font-weight');
  expect(found, `${selector} declares no font-weight`).not.toHaveLength(0);
  return Number(found[found.length - 1]);
}

/** The ceiling of a rung's clamp, in px — the widest this heading ever renders,
 * which is the size the display weight has to hold up at. */
function clampCeilingPx(value: string): number {
  const parts = /clamp\([^,]+,[^,]+,([^)]+)\)/.exec(value);
  expect(parts, `not a three-part clamp: ${value}`).not.toBeNull();
  const raw = (parts?.[1] ?? '').trim();
  const num = Number(raw.replace(/rem|px/, ''));
  return raw.endsWith('rem') ? num * REM : num;
}

/** Every heading rung the app sets a size for, largest first once resolved. The
 * bare tags are the hero class (auth pages, the public invite/RSVP surfaces); the
 * `.main-stage` pair is the authed shell, which runs a much smaller scale. */
const RUNGS = ['h1', 'h2', '.main-stage h1', '.main-stage h2', 'h3'] as const;

describe('the display face is Fraunces (WEB-TYPE)', () => {
  it('self-hosts the two-axis master and binds it to --font-serif', () => {
    expect(LAYOUT).toContain('fraunces-latin-opsz-wght-normal.woff2');
    expect(LAYOUT).toContain("variable: '--font-serif'");
    // Registered is not enough — the variable has to reach the document.
    expect(LAYOUT).toContain('fraunces.variable');
    expect(CSS).toMatch(/--font-serif:\s*"Fraunces"/);
    // --font-display is the handle every heading and `.font-display` call site
    // reads; if it stops pointing at the serif slot the swap misses all of them.
    expect(themeToken('--font-display')).toBe('var(--font-serif)');
  });

  it('registers the whole weight range, because the whole range is what shipped', () => {
    // Understating the range makes next/font declare a narrower @font-face than the
    // file supports and hands the missing weights back to the synthesizer — which is
    // the exact failure `font-synthesis-weight: none` below is there to make visible.
    expect(LAYOUT).toMatch(/fraunces-latin-opsz-wght-normal\.woff2['"],\s*weight:\s*'100 900'/);
    expect(LAYOUT).not.toMatch(/fraunces-(thin|light|medium|semibold|bold|black|\w*italic)/i);
  });

  it('retires Source Serif 4 and Instrument Sans — face, registration and binary', () => {
    // Scanned as VALUES and PATHS, not as prose: the comments above these rules
    // record which faces were replaced and why, and a gate that forbade the words
    // would delete that history to prove a point about bindings.
    const families: string[] = [];
    root.walkDecls((decl) => {
      if (/^--font-|^font-family$/.test(decl.prop)) families.push(decl.value);
    });
    expect(families.join(' | ')).not.toMatch(/source serif|instrument sans/i);
    // Positive control: the scan does read the font declarations it is judging.
    expect(families.join(' | ')).toMatch(/Figtree/);
    expect(families.join(' | ')).toMatch(/Fraunces/);

    const loaded = [...LAYOUT.matchAll(/\.\/fonts\/([\w.-]+\.woff2)/g)].map((m) => m[1]).sort();
    expect(loaded).toEqual([
      'figtree-latin-wght-normal.woff2',
      'fraunces-latin-opsz-wght-normal.woff2',
    ]);

    // Not merely unreferenced: gone. An unregistered woff2 left in app/fonts/ is an
    // invitation to re-bind the face this change replaced, and it ships bytes into
    // the build output for a face nothing loads.
    expect(readdirSync(FONT_DIR).sort()).toEqual([
      'figtree-OFL.txt',
      'figtree-latin-wght-normal.woff2',
      'fraunces-OFL.txt',
      'fraunces-latin-opsz-wght-normal.woff2',
    ]);
  });

  it('sets every heading in the display face, upright, and never synthesized', () => {
    expect(only('h1', 'font-family')).toBe('var(--font-display)');
    // opsz follows the rendered size only under `auto`; without it every rung from
    // the 22px stage H2 to the 76px hero renders the same 9pt drawing.
    expect(only('h1', 'font-optical-sizing')).toBe('auto');
    // No italic master is loaded, and the display face is upright by design.
    expect(only('h1', 'font-style')).toBe('normal');
    expect(only('h1', 'font-synthesis-weight')).toBe('none');
  });

  it('ships the hero class at the founder’s 450 and never asks off-axis', () => {
    expect(weightOf('h1')).toBe(450);
    expect(weightOf('h2')).toBe(450);
    for (const rung of RUNGS) {
      const weight = weightOf(rung);
      expect(weight, `${rung} asks for ${weight}`).toBeGreaterThanOrEqual(100);
      expect(weight, `${rung} asks for ${weight}`).toBeLessThanOrEqual(900);
    }
  });

  it('steps the weight UP as the rung gets smaller, never down', () => {
    const ladder = RUNGS.map((rung) => ({
      rung,
      px: clampCeilingPx(only(rung, 'font-size')),
      weight: weightOf(rung),
    })).sort((a, b) => b.px - a.px);

    for (let i = 1; i < ladder.length; i++) {
      const bigger = ladder[i - 1] as (typeof ladder)[number];
      const smaller = ladder[i] as (typeof ladder)[number];
      expect(
        smaller.weight,
        `${smaller.rung} (${smaller.px}px) is lighter than ${bigger.rung} (${bigger.px}px)`,
      ).toBeGreaterThanOrEqual(bigger.weight);
    }
    // Positive control: the ladder is a real, ordered read of five distinct rungs —
    // a green run above means "measured and rising", not "one rung compared to
    // itself". The 34px stage H1 must sit between the 49.6px H2 and the 29.6px H3.
    expect(ladder.map((r) => r.rung)).toEqual([
      'h1',
      'h2',
      '.main-stage h1',
      'h3',
      '.main-stage h2',
    ]);
    expect(ladder[0]?.weight).toBeLessThan(ladder[ladder.length - 1]?.weight ?? 0);
  });
});

describe('the body and UI face is Figtree (WEB-TYPE)', () => {
  it('self-hosts the variable master and binds it to --font-sans', () => {
    expect(LAYOUT).toContain('figtree-latin-wght-normal.woff2');
    expect(LAYOUT).toContain("variable: '--font-sans'");
    expect(LAYOUT).toContain('figtree.variable');
    expect(LAYOUT).toMatch(/figtree-latin-wght-normal\.woff2['"],\s*weight:\s*'300 900'/);
    expect(CSS).toMatch(/--font-sans:\s*"Figtree"/);
    // The retired mono role still resolves through the sans slot, so the swap has to
    // carry `.tabular` and every `font-mono` call site with it.
    expect(themeToken('--font-mono')).toBe('var(--font-sans)');
    expect(themeToken('--font-body')).toBe('var(--font-sans)');
  });

  it('sets body copy at 400 and the buttons and nav at 500–600', () => {
    expect(weightOf('body')).toBe(400);
    for (const selector of [
      '.btn-primary',
      '.btn-secondary',
      '.btn-ghost',
      '.nav-item .nav-label',
    ]) {
      const weight = weightOf(selector);
      expect(weight, `${selector} asks for ${weight}`).toBeGreaterThanOrEqual(500);
      expect(weight, `${selector} asks for ${weight}`).toBeLessThanOrEqual(600);
    }
  });

  it('carries the OFL text beside each binary it licenses', () => {
    for (const [file, family] of [
      ['fraunces-OFL.txt', 'Fraunces'],
      ['figtree-OFL.txt', 'Figtree'],
    ]) {
      const ofl = readFileSync(`${FONT_DIR}/${file}`, 'utf8');
      expect(ofl, file).toContain('SIL OPEN FONT LICENSE Version 1.1');
      expect(ofl, file).toContain(family as string);
    }
  });
});
