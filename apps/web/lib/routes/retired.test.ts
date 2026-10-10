import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import nextConfig from '~/next.config';
import { RETIRED_PREFIXES, RETIRED_TARGET, isRetiredPath } from './retired';

/**
 * The receipts-room slimdown. Two things have to hold for a retired surface, and they
 * fail in opposite directions:
 *
 *  - it must actually be gone (a real permanent redirect, from the middleware, so it
 *    is a redirect a browser and a crawler can see rather than a soft client push), and
 *  - it must take NOTHING live with it. A too-greedy match on a page noun would also
 *    match an /api path that only differs by an /api prefix. The SMS coach is
 *    apps/web/lib/channel/coach/runtime.ts, not /api/coach. A match there would take
 *    the product down, silently.
 */

const middleware = readFileSync(
  fileURLToPath(new URL('../../middleware.ts', import.meta.url)),
  'utf8',
);

const pagePath = (rel: string) =>
  fileURLToPath(new URL(`../../app/(authed)/${rel}`, import.meta.url));

describe('isRetiredPath', () => {
  it('matches every retired surface and anything underneath it', () => {
    for (const prefix of RETIRED_PREFIXES) {
      expect(isRetiredPath(prefix), prefix).toBe(true);
      expect(isRetiredPath(`${prefix}/logs`), `${prefix}/logs`).toBe(true);
    }
  });

  it('leaves the surfaces that DO earn their place alone', () => {
    for (const live of ['/approvals', '/trail', '/settings', '/family', '/plan', '/home']) {
      expect(isRetiredPath(live), live).toBe(false);
    }
  });

  /**
   * The load-bearing one. Retiring the /coach page must never match /api/coach.
   * The SMS coach is apps/web/lib/channel/coach/runtime.ts, not that route. The
   * web /api/coach handlers are gone; the prefix guard stays so a page redirect
   * cannot swallow an /api path that shares its noun.
   */
  it('never matches an API route that shares a retired page’s noun', () => {
    for (const api of [
      '/api/coach',
      '/api/coach/action',
      '/api/coach/attachments',
      '/api/companion',
    ]) {
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

describe('the page stubs are gone; next.config serves the 308', () => {
  it.each([
    ['coach/page.tsx'],
    ['companion/page.tsx'],
    ['companion/logs/page.tsx'],
    ['saved/page.tsx'],
  ])('%s no longer exists', (rel) => {
    expect(existsSync(pagePath(rel))).toBe(false);
  });

  it('forwards each surface, and anything under it, permanently to /home', async () => {
    if (typeof nextConfig.redirects !== 'function')
      throw new Error('next.config has no redirects()');
    const rules = await nextConfig.redirects();
    for (const prefix of RETIRED_PREFIXES) {
      for (const source of [prefix, `${prefix}/:path*`]) {
        const rule = rules.find((r) => r.source === source);
        expect(rule, source).toMatchObject({ destination: RETIRED_TARGET, permanent: true });
      }
    }
  });

  it('forwards no /api path (a page noun like /coach does not take /api/coach with it)', async () => {
    if (typeof nextConfig.redirects !== 'function')
      throw new Error('next.config has no redirects()');
    const sources = (await nextConfig.redirects()).map((r) => r.source);
    for (const source of sources) {
      expect(source.startsWith('/api')).toBe(false);
    }
  });
});
