import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';
import { describe, expect, it } from 'vitest';

/**
 * SITE-01 gate — @layer discipline in the marketing-site design system.
 *
 * Custom component classes MUST live inside an `@layer` block so Tailwind v4
 * utilities (which sit in `@layer utilities`) win by layer order. An UNLAYERED
 * class rule outranks every utility regardless of source order — `.card{display:block}`
 * beat `flex flex-col gap-*` and `.meta` font-size beat `text-lg`, which silently
 * collapsed the answers/milestones card grids to inline text and shrank the subpage
 * ledes to 13.6px fine print. This is the same trap globals.css already documents
 * for h1-h4 (moved to @layer base); the component classes were left exposed.
 *
 * The invariant: no class-bearing rule sits at the stylesheet root (outside any
 * @layer). Element + pseudo rules (html, body, ::selection, scrollbar) may — no
 * utility competes with them. Parsing the SOURCE is sufficient: Tailwind preserves
 * @layer membership into the build, and an unlayered source rule is exactly what
 * produces the "layer depth 0" that beats utilities in the shipped CSS.
 */

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

describe('globals.css — @layer discipline (SITE-01)', () => {
  it('has no unlayered custom class rule — every one sits inside @layer so utilities win', () => {
    const unlayered: string[] = [];
    root.walkRules((rule) => {
      if (hasClassSelector(rule.selector) && !insideLayer(rule)) {
        unlayered.push(rule.selector.replace(/\s+/g, ' ').trim());
      }
    });
    expect(unlayered).toEqual([]);
  });

  it('wraps the audited component classes inside @layer', () => {
    const layered = new Set<string>();
    root.walkAtRules('layer', (layer) => {
      layer.walkRules((rule) => {
        for (const match of rule.selector.matchAll(/\.([-_a-zA-Z][-_a-zA-Z0-9]*)/g)) {
          const name = match[1];
          if (name) layered.add(name);
        }
      });
    });
    for (const cls of ['card', 'meta', 'panel-oat', 'pill', 'btn-primary', 'eyebrow', 'link', 'pill-eyebrow']) {
      expect(layered.has(cls), `.${cls} must be inside @layer`).toBe(true);
    }
  });
});
