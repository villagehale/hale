import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Nothing gates a className against globals.css — a component can ship classes that
 * are defined NOWHERE and every other gate stays green. This closes that hole for
 * the flag-off sign-in controls: every bespoke `auth-` class the magic-link form
 * and the sign-in page reference must have a definition in globals.css. The shore
 * door itself is ConnectStage, not an `auth-` class. Sibling of
 * companion-css-coverage.test.ts.
 */

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

const CSS = read('../../app/globals.css');
const SOURCES = [
  read('./auth-shell.tsx'),
  read('./magic-link-request-form.tsx'),
  read('../../app/sign-in/page.tsx'),
  read('../../app/sign-up/page.tsx'),
];

// Bespoke prefix the auth surface owns. (`.auth-control*` in the sidebar is a
// different surface and is never referenced by these sources.)
const BESPOKE = /^auth-/;

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

/** `.auth-field` must not be satisfied by `.auth-field-main` — the class name must
 * end at a non-class character. */
function definedInCss(cls: string): boolean {
  return new RegExp(`\\.${cls}(?![a-zA-Z0-9_-])`).test(CSS);
}

describe('auth surface CSS coverage (every bespoke class is defined)', () => {
  it('extracts a real class set (guards against a vacuous pass)', () => {
    expect(used.size).toBeGreaterThanOrEqual(8);
    expect(used).toContain('auth-google');
    expect(used).toContain('auth-submit');
    expect(used).toContain('auth-field');
    expect(used).not.toContain('auth-stage');
    expect(used).not.toContain('auth-backdrop');
  });

  it('defines every bespoke auth class the frame + pages use', () => {
    const missing = [...used].filter((cls) => !definedInCss(cls)).sort();
    expect(missing).toEqual([]);
  });
});
