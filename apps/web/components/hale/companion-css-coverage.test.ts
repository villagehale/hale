import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEVELOPMENT_DOMAINS } from '~/lib/companion/development-snapshot';

/**
 * Nothing gates a className against globals.css — a component can ship classes that
 * are defined NOWHERE and every other gate stays green (this happened: a concurrent
 * `git restore` clobbered the companion CSS section pre-commit and CI passed).
 * This test closes that hole for the Companion surface: every bespoke-prefixed
 * class the components use must have a definition in globals.css, and every
 * `--domain-*` variable the donut/legend reference must be declared.
 */

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

const CSS = read('../../app/globals.css');
const SOURCES = [read('./companion-tabs.tsx'), read('../../app/(authed)/companion/page.tsx')];

// Bespoke (non-utility) prefixes the companion surface owns or leans on.
const BESPOKE = /^(?:comp|care|pill)-/;

function bespokeClassesOf(source: string): Set<string> {
  const classes = new Set<string>();
  for (const [, group] of source.matchAll(/className="([^"]*)"/g)) {
    for (const token of (group ?? '').split(/\s+/)) {
      if (BESPOKE.test(token)) classes.add(token);
    }
  }
  return classes;
}

const used = new Set(SOURCES.flatMap((s) => [...bespokeClassesOf(s)]));

/** `.comp-hub` must not be satisfied by `.comp-hub-avatar` — the class name must
 * end at a non-class character. */
function definedInCss(cls: string): boolean {
  return new RegExp(`\\.${cls}(?![a-zA-Z0-9_-])`).test(CSS);
}

describe('companion CSS coverage (every bespoke class is defined)', () => {
  it('extracts a real class set (guards against a vacuous pass)', () => {
    expect(used.size).toBeGreaterThanOrEqual(20);
    expect(used).toContain('comp-hub');
    expect(used).toContain('care-chip');
  });

  it('defines every bespoke class the companion components use', () => {
    const missing = [...used].filter((cls) => !definedInCss(cls)).sort();
    expect(missing).toEqual([]);
  });

  it('declares a --domain-* variable for every development domain the donut renders', () => {
    const missing = DEVELOPMENT_DOMAINS.map((d) => `--domain-${d.area}`).filter(
      (v) => !CSS.includes(`${v}:`),
    );
    expect(missing).toEqual([]);
  });
});
