import createMiddleware from 'next-intl/middleware';
import { NextRequest, NextResponse } from 'next/server';
import { describe, expect, it } from 'vitest';
import { routing } from '~/i18n/routing';
import middleware, { stampShareSearch } from '../../middleware';
import { SHARE_SEARCH_HEADER } from './share-search-header';

const intl = createMiddleware(routing);

function page(path: string): NextRequest {
  return new NextRequest(new URL(path, 'https://www.villagehale.com'), {
    headers: {
      'accept-language': 'fr,en;q=0.8',
      cookie: 'session=1',
      'x-vercel-ip-country': 'CA',
    },
  });
}

function headerBag(response: Response): Map<string, string> {
  const headers = new Map<string, string>();
  response.headers.forEach((value, key) => {
    headers.set(key.toLowerCase(), value);
  });
  return headers;
}

describe('share-search header', () => {
  it('appends the query without replacing the headers next-intl already forwards', () => {
    const response = NextResponse.next({
      request: { headers: new Headers({ cookie: 'session=1', 'x-vercel-ip-country': 'US' }) },
    });
    stampShareSearch(response, '?promo_phase=holiday');
    const listed = response.headers.get('x-middleware-override-headers') ?? '';
    expect(listed.split(',')).toEqual(
      expect.arrayContaining(['cookie', 'x-vercel-ip-country', SHARE_SEARCH_HEADER]),
    );
    expect(response.headers.get(`x-middleware-request-${SHARE_SEARCH_HEADER}`)).toBe(
      '?promo_phase=holiday',
    );
    expect(response.headers.get('x-middleware-request-cookie')).toBe('session=1');
  });

  it('leaves a response alone when it is not forwarding request headers', () => {
    const response = new Response(null, { status: 307, headers: { location: '/fr' } });
    stampShareSearch(response, '?promo_phase=holiday');
    expect(response.headers.get('x-middleware-override-headers')).toBeNull();
    expect(response.headers.get(`x-middleware-request-${SHARE_SEARCH_HEADER}`)).toBeNull();
  });
});

const PAGE_PATHS = ['/', '/fr', '/zh', '/pricing'] as const;

describe('middleware promo_phase regression', () => {
  it('without promo_phase, locale redirects and next-intl headers are unchanged', () => {
    for (const path of PAGE_PATHS) {
      const before = intl(page(path));
      const after = middleware(page(path));
      expect(after.status, path).toBe(before.status);
      expect(headerBag(after), path).toEqual(headerBag(before));
      expect(after.headers.get(`x-middleware-request-${SHARE_SEARCH_HEADER}`), path).toBeNull();
    }
  });

  it('with promo_phase, stamps the share search header', () => {
    const search = '?promo_phase=holiday';
    for (const path of PAGE_PATHS) {
      const before = intl(page(`${path}${search}`));
      const after = middleware(page(`${path}${search}`));
      expect(after.status, path).toBe(before.status);
      expect(after.headers.get('location'), path).toBe(before.headers.get('location'));
      expect(after.headers.get('x-middleware-rewrite'), path).toBe(
        before.headers.get('x-middleware-rewrite'),
      );
      expect(after.headers.get('x-middleware-request-x-next-intl-locale'), path).toBe(
        before.headers.get('x-middleware-request-x-next-intl-locale'),
      );
      expect(after.headers.get(`x-middleware-request-${SHARE_SEARCH_HEADER}`), path).toBe(search);
      expect(after.headers.get('x-middleware-override-headers') ?? '', path).toContain(
        SHARE_SEARCH_HEADER,
      );
    }
  });
});
