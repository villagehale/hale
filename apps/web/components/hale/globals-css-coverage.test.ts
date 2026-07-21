import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEVELOPMENT_DOMAINS } from '~/lib/companion/development-snapshot';

/**
 * Nothing else gates a className against globals.css — a component can ship a class
 * that is defined NOWHERE and every other gate stays green (this happened once: a
 * concurrent `git restore` clobbered a CSS section pre-commit and CI passed). The
 * companion-only version of this test closed the hole for three prefixes; this one
 * generalises it to EVERY bespoke namespace globals.css owns, across the whole authed
 * surface + the shared hale components.
 *
 * How it stays honest without false-positiving on Tailwind: globals.css is hand-authored
 * CSS (Tailwind utilities are generated at build, never written here), so the set of
 * bespoke namespaces IS exactly the set of first-hyphen segments of the classes it
 * defines — e.g. `comp-`, `village-`, `home-`, `apppromo-`. Two of those segments collide
 * with Tailwind utility names (`font-medium`, `pb-4`), so they're denied; every other
 * derived prefix is a real component namespace. A used class whose prefix is in that set
 * must resolve to a definition in globals.css.
 */

const dir = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

const CSS = read('../../app/globals.css');

/** Every class selector defined in globals.css (`.foo`), name ending at a non-class
 * character so `.comp-hub` is not satisfied by `.comp-hub-avatar`. */
const DEFINED = new Set<string>();
for (const [, name] of CSS.matchAll(/\.([a-zA-Z][a-zA-Z0-9_-]*)/g)) {
  if (name) DEFINED.add(name);
}

/** Prefixes whose authored form looks like a Tailwind utility (`.font-*` maps the
 * three font faces; a lone `.pb-*` helper) — a component's `font-medium` / `pb-4`
 * are Tailwind, not bespoke, so these two namespaces are not gated. */
const TAILWIND_COLLISIONS = new Set(['font', 'pb']);

/** The bespoke namespaces = first-hyphen segment of every hyphenated authored class,
 * minus the Tailwind collisions. */
const BESPOKE_PREFIXES = new Set<string>();
for (const cls of DEFINED) {
  const i = cls.indexOf('-');
  if (i > 0) {
    const prefix = cls.slice(0, i);
    if (!TAILWIND_COLLISIONS.has(prefix)) BESPOKE_PREFIXES.add(prefix);
  }
}

function isBespoke(token: string): boolean {
  const i = token.indexOf('-');
  return i > 0 && BESPOKE_PREFIXES.has(token.slice(0, i));
}

/** Source files to scan: the shared hale components + every authed route (page +
 * colocated client files), excluding tests. */
function sources(root: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = `${root}/${entry.name}`;
    if (entry.isDirectory()) sources(full, acc);
    else if (/\.(tsx?|jsx?)$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name)) acc.push(full);
  }
  return acc;
}
const FILES = [...sources(dir('.')), ...sources(dir('../../app/(authed)'))];

// className values, in the two forms the codebase uses: className="..." and
// className={ EXPR } (EXPR may hold string / template literals with one level of
// ${} nesting — the map/ternary class strings). Scoping to className keeps ids,
// aria text, and prose comments out of the token stream.
const STATIC_CLASSNAME = /className\s*=\s*"([^"]*)"/g;
const BRACED_CLASSNAME = /className\s*=\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g;
const STRING_LITERAL = /"([^"]*)"|'([^']*)'|`([^`]*)`/g;

function collect(classText: string, sink: string[]): void {
  for (let token of classText.split(/\s+/)) {
    token = token.replace(/\$\{.*$/, ''); // drop an interpolation tail (`attach-chip-${c}`)
    if (token.endsWith('-')) continue; // interpolation stub, not a whole class
    if (!/^[a-z][a-z0-9]*-[a-z0-9-]+$/.test(token)) continue; // class-shaped tokens only
    sink.push(token);
  }
}

const usedBespoke = new Set<string>();
let totalUsages = 0;
for (const file of FILES) {
  const src = readFileSync(file, 'utf8');
  const tokens: string[] = [];
  for (const m of src.matchAll(STATIC_CLASSNAME)) collect(m[1] ?? '', tokens);
  for (const m of src.matchAll(BRACED_CLASSNAME)) {
    for (const lit of (m[1] ?? '').matchAll(STRING_LITERAL)) {
      collect(lit[1] ?? lit[2] ?? lit[3] ?? '', tokens);
    }
  }
  for (const token of tokens) {
    if (!isBespoke(token)) continue;
    totalUsages += 1;
    usedBespoke.add(token);
  }
}

describe('globals.css coverage — every bespoke class the authed surface uses is defined', () => {
  it('extracts a real, broad class set (guards against a vacuous pass)', () => {
    // Floors well below the current reality (511 usages / 236 distinct across 55
    // namespaces): a big regression here means the extractor silently broke.
    expect(totalUsages).toBeGreaterThanOrEqual(350);
    expect(usedBespoke.size).toBeGreaterThanOrEqual(120);
    expect(BESPOKE_PREFIXES.size).toBeGreaterThanOrEqual(40);
    // Anchors from distinct namespaces prove the scan reached each surface.
    for (const anchor of ['comp-hub', 'care-chip', 'village-3col', 'home-col', 'apppromo-sheet']) {
      expect(usedBespoke).toContain(anchor);
    }
  });

  it('defines every bespoke class used under components/hale + app/(authed)', () => {
    const missing = [...usedBespoke].filter((cls) => !DEFINED.has(cls)).sort();
    expect(missing).toEqual([]);
  });

  it('declares a --domain-* variable for every development domain the donut renders', () => {
    const missing = DEVELOPMENT_DOMAINS.map((d) => `--domain-${d.area}`).filter(
      (v) => !CSS.includes(`${v}:`),
    );
    expect(missing).toEqual([]);
  });
});
