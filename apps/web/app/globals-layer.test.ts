import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';
import { describe, expect, it } from 'vitest';

/**
 * WEB-LAYER gate — @layer discipline in the product-app design system.
 *
 * Custom component classes MUST live inside an `@layer` block so Tailwind v4
 * utilities (which sit in `@layer utilities`) win by layer order. An UNLAYERED
 * class rule outranks every utility regardless of source order — in apps/site the
 * same trap collapsed the card grids and shrank the subpage ledes; here it made
 * `.eyebrow`'s colour beat the `text-spruce` / `text-berry` its call sites wrote,
 * and `.meta`'s weight beat `font-normal`. apps/site's gate (globals-layer.test.ts)
 * asserts ZERO unlayered class rules; this stylesheet predates the rule with 500+
 * of them across every feature surface, and layering them wholesale would flip
 * precedence app-wide in one unverifiable step.
 *
 * So this gate is a RATCHET instead of an absolute: the count of unlayered class
 * rules may only ever go DOWN. New CSS must be layered (adding an unlayered rule
 * fails), and each phase of the VIL-209 arc lowers the baseline as it migrates its
 * surfaces — until the number reaches 0 and this file can assert what apps/site's
 * does. Element + pseudo rules (html, body, ::selection, scrollbar, keyframes) are
 * exempt: no utility competes with them.
 *
 * Parsing the SOURCE is sufficient: Tailwind preserves @layer membership into the
 * build, and an unlayered source rule is exactly what produces the "layer depth 0"
 * that beats utilities in the shipped CSS.
 */

/** Unlayered class rules remaining in globals.css. LOWER THIS as surfaces migrate;
 * never raise it. Any new component class goes inside `@layer components`. */
const UNLAYERED_BASELINE = 494;

const CSS = readFileSync(fileURLToPath(new URL('./globals.css', import.meta.url)), 'utf8');
const root = postcss.parse(CSS);

/** A selector references a class iff it carries a `.name` token. Pseudo-classes
 * use `:`, pseudo-elements `::`, attributes `[]`, elements nothing — none match. */
function hasClassSelector(selector: string): boolean {
  return /\.[-_a-zA-Z]/.test(selector);
}

/** Whether a node sits inside any `@layer` block (directly or via nested @media). */
function insideLayer(node: postcss.Node): boolean {
  let parent = node.parent;
  while (parent) {
    if (parent.type === 'atrule' && (parent as postcss.AtRule).name === 'layer') return true;
    parent = parent.parent;
  }
  return false;
}

function unlayeredClassRules(): string[] {
  const found: string[] = [];
  root.walkRules((rule) => {
    if (hasClassSelector(rule.selector) && !insideLayer(rule)) {
      found.push(rule.selector.replace(/\s+/g, ' ').trim());
    }
  });
  return found;
}

function layeredClassNames(): Set<string> {
  const names = new Set<string>();
  root.walkAtRules('layer', (layer) => {
    layer.walkRules((rule) => {
      for (const match of rule.selector.matchAll(/\.([-_a-zA-Z][-_a-zA-Z0-9]*)/g)) {
        const name = match[1];
        if (name) names.add(name);
      }
    });
  });
  return names;
}

describe('globals.css — @layer discipline (VIL-209)', () => {
  it('holds the unlayered-class debt at the baseline — a new unlayered rule fails', () => {
    expect(unlayeredClassRules().length).toBe(UNLAYERED_BASELINE);
  });

  it('wraps the shared type roles inside @layer so a text-*/font-* utility wins', () => {
    const layered = layeredClassNames();
    for (const cls of ['eyebrow', 'meta', 'folio', 'tabular', 'font-display', 'font-body', 'font-mono']) {
      expect(layered.has(cls), `.${cls} must be inside @layer`).toBe(true);
    }
  });
});
