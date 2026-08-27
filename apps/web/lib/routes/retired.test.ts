import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RETIRED_PREFIXES, RETIRED_TARGET, isRetiredPath } from './retired';

/**
 * The receipts-room slimdown. Two things have to hold for a retired surface, and they
 * fail in opposite directions:
 *
 *  - it must actually be gone (a real permanent redirect, from the middleware, so it
 *    is a redirect a browser and a crawler can see rather than a soft client push), and
 *  - it must take NOTHING live with it — above all the API routes that back the SMS
 *    coach, whose paths only differ by an /api prefix. A too-greedy match there would
 *    take the product down, silently.
 */

const middleware = readFileSync(
  fileURLToPath(new URL('../../middleware.ts', import.meta.url)),
  'utf8',
);

const page = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../app/(authed)/${rel}`, import.meta.url)), 'utf8');

describe('isRetiredPath', () => {
  it('matches every retired surface and anything underneath it', () => {
    for (const prefix of RETIRED_PREFIXES) {
      expect(isRetiredPath(prefix), prefix).toBe(true);
      expect(isRetiredPath(`${prefix}/logs`), `${prefix}/logs`).toBe(true);
    }
  });

  it('leaves the surfaces that DO earn their place alone', () => {
    for (const live of ['/approvals', '/trail', '/settings', '/family', '/plan', '/village']) {
      expect(isRetiredPath(live), live).toBe(false);
    }
  });

  /**
   * The load-bearing one. /api/coach/* is the SMS coach. Retiring a browser page
   * must never retire the API that shares its noun.
   */
  it('never matches an API route that shares a retired page’s noun', () => {
    for (const api of ['/api/coach', '/api/coach/action', '/api/coach/attachments', '/api/companion']) {
      expect(isRetiredPath(api), api).toBe(false);
    }
  });

  it('does not match a route that merely starts with the same letters', () => {
    expect(isRetiredPath('/coaching')).toBe(false);
    expect(isRetiredPath('/savedsearches')).toBe(false);
  });

  it('lands every retired surface somewhere that is not itself retired', () => {
    expect(isRetiredPath(RETIRED_TARGET)).toBe(false);
  });
});

describe('the middleware serves the forward', () => {
  it('answers with a real 308 to the shared target, not a soft client push', () => {
    expect(middleware).toContain('isRetiredPath(pathname)');
    expect(middleware).toContain(
      'NextResponse.redirect(new URL(RETIRED_TARGET, req.nextUrl), 308)',
    );
  });

  /**
   * Order matters: the auth gate returns a /sign-in redirect, so a retired route placed
   * after it would answer "sign in first" and only then "this is gone" — two hops and a
   * sign-in wall in front of a page that no longer exists.
   */
  it('answers before the auth gate and before the protected-path early return', () => {
    const retired = middleware.indexOf('isRetiredPath(pathname)');
    expect(retired).toBeGreaterThan(-1);
    expect(retired).toBeLessThan(middleware.indexOf('isProtectedPath(pathname)'));
    expect(retired).toBeLessThan(middleware.indexOf('if (!req.auth)'));
  });
});

describe('the pages themselves cannot render (defense in depth)', () => {
  it.each([
    ['coach/page.tsx'],
    ['companion/page.tsx'],
    ['companion/logs/page.tsx'],
    ['saved/page.tsx'],
  ])('%s is a permanent redirect and nothing else', (rel) => {
    const src = page(rel);
    expect(src).toContain("import { permanentRedirect } from 'next/navigation'");
    expect(src).toContain(`permanentRedirect('${RETIRED_TARGET}')`);
    // No surviving surface: a retired page that still imported its old tree would keep
    // that code reachable the moment the middleware rule was touched.
    expect(src).not.toContain('~/components/');
    expect(src).not.toContain('~/lib/');
  });
});
