import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DRILL_HEROES } from './hero-map';

/**
 * Design handoff §3.2 single-hero contract: a page registered in DRILL_HEROES is
 * given a breadcrumb + back + serif title by the shell's PageHero. It must NOT
 * render its own <header>/<h1> too — that produces two titles and two back
 * affordances on the same screen (the W1-QA "duplicate drill-page chrome" class).
 * This asserts the invariant across every drill page so the regression can never
 * creep back onto a new one.
 */

const authedRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'app', '(authed)');

function pageSource(route: string): string {
  return readFileSync(join(authedRoot, route.replace(/^\//, ''), 'page.tsx'), 'utf8');
}

describe('drill pages defer their hero to the shell (§3.2)', () => {
  for (const route of Object.keys(DRILL_HEROES)) {
    it(`${route} renders no own <h1> or <header>`, () => {
      const src = pageSource(route);
      expect(src).not.toMatch(/<h1[\s>]/);
      expect(src).not.toMatch(/<header[\s>]/);
    });
  }
});
