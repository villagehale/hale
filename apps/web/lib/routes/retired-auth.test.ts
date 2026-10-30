import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isRetiredAuthPath, retiredAuthRedirectUrl } from './retired-auth';

/**
 * The email doors. Two things have to hold:
 *
 *  - a real 308 from the middleware, ahead of the auth gate, and
 *  - the Location is bare /sign-in. A token in the query or the path must not
 *    survive, and an /api route that shares a noun must not be redirected.
 */

const middleware = readFileSync(
  fileURLToPath(new URL('../../middleware.ts', import.meta.url)),
  'utf8',
);

const page = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../app/${rel}`, import.meta.url)), 'utf8');

const DOORS = [
  '/forgot-password',
  '/reset-password',
  '/magic-link',
  '/m/magic',
  '/verify',
  '/invite',
  '/invite/raw-token',
] as const;

describe('isRetiredAuthPath', () => {
  it('matches every retired email door, a trailing slash, and a nested token', () => {
    for (const door of DOORS) {
      expect(isRetiredAuthPath(door), door).toBe(true);
      expect(isRetiredAuthPath(`${door}/`), `${door}/`).toBe(true);
    }
    expect(isRetiredAuthPath('/forgot-password/extra')).toBe(true);
    expect(isRetiredAuthPath('/m/magic/extra')).toBe(true);
  });

  it('leaves the live doors alone', () => {
    for (const live of ['/sign-in', '/signin', '/connect', '/oauth/authorize', '/admin', '/home']) {
      expect(isRetiredAuthPath(live), live).toBe(false);
    }
  });

  it('never matches an API route that shares a retired page’s noun', () => {
    for (const api of [
      '/api/auth/magic-link/request',
      '/api/auth/claim-phone/request',
      '/api/invite',
      '/api/invite/raw-token/accept',
      '/api/cron/registration-verify',
    ]) {
      expect(isRetiredAuthPath(api), api).toBe(false);
    }
  });

  it('does not match a route that merely starts with the same letters', () => {
    expect(isRetiredAuthPath('/verification')).toBe(false);
    expect(isRetiredAuthPath('/magic-links')).toBe(false);
    expect(isRetiredAuthPath('/invited')).toBe(false);
  });
});

describe('retiredAuthRedirectUrl', () => {
  it('drops a query token, a hash, and a path token', () => {
    const reset = retiredAuthRedirectUrl(
      new URL('https://app.example/reset-password?token=secret#frag'),
    );
    expect(reset.href).toBe('https://app.example/sign-in');
    expect(reset.search).toBe('');
    expect(reset.hash).toBe('');

    const invite = retiredAuthRedirectUrl(new URL('https://app.example/invite/raw-token?x=1'));
    expect(invite.href).toBe('https://app.example/sign-in');

    const magic = retiredAuthRedirectUrl(
      new URL('https://app.example/magic-link?token=abc&callbackUrl=/home'),
    );
    expect(magic.href).toBe('https://app.example/sign-in');
  });
});

describe('the middleware serves the forward', () => {
  it('answers with a real 308 built from the origin, not the request URL', () => {
    expect(middleware).toContain('isRetiredAuthPath(pathname)');
    expect(middleware).toContain(
      'NextResponse.redirect(retiredAuthRedirectUrl(req.nextUrl), 308)',
    );
    expect(middleware).not.toContain(
      "NextResponse.redirect(new URL('/sign-in', req.nextUrl), 308)",
    );
  });

  it('answers before the auth gate and before the protected-path early return', () => {
    const retired = middleware.indexOf('isRetiredAuthPath(pathname)');
    expect(retired).toBeGreaterThan(-1);
    expect(retired).toBeLessThan(middleware.indexOf('isProtectedPath(pathname)'));
    expect(retired).toBeLessThan(middleware.indexOf('if (!req.auth)'));
  });
});

describe('the pages themselves cannot render (defense in depth)', () => {
  it.each([
    ['forgot-password/page.tsx'],
    ['reset-password/page.tsx'],
    ['magic-link/page.tsx'],
    ['m/magic/page.tsx'],
    ['verify/page.tsx'],
    ['invite/[token]/page.tsx'],
  ])('%s is a permanent redirect and nothing else', (rel) => {
    const src = page(rel);
    expect(src).toContain("import { permanentRedirect } from 'next/navigation'");
    expect(src).toContain("permanentRedirect('/sign-in')");
    expect(src).not.toContain('~/components/');
    expect(src).not.toContain('searchParams');
    expect(src).not.toContain('token');
  });
});
