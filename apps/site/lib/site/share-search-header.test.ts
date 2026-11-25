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

describe('middleware without a promo query', () => {
  it.each(['/', '/fr', '/en', '/fr/pricing'])(
    'keeps next-intl headers and redirects for %s',
    (path) => {
      const before = intl(page(path));
      const after = middleware(page(path));
      const beforeHeaders = headerBag(before);
      const afterHeaders = headerBag(after);
      expect(after.status).toBe(before.status);
      expect(afterHeaders.get('location') ?? null).toBe(beforeHeaders.get('location') ?? null);
      expect(afterHeaders.get('x-middleware-rewrite') ?? null).toBe(
        beforeHeaders.get('x-middleware-rewrite') ?? null,
      );
      expect(afterHeaders.get('link') ?? null).toBe(beforeHeaders.get('link') ?? null);
      for (const [key, value] of beforeHeaders) {
        if (key === 'x-middleware-override-headers') continue;
        expect(afterHeaders.get(key), `${path} ${key}`).toBe(value);
      }
      const listed = beforeHeaders.get('x-middleware-override-headers');
      const stamped = afterHeaders.get('x-middleware-override-headers');
      if (listed == null) {
        expect(stamped ?? null).toBeNull();
        expect(afterHeaders.get(`x-middleware-request-${SHARE_SEARCH_HEADER}`) ?? null).toBeNull();
        return;
      }
      const names = listed.split(',').map((name) => name.trim());
      const afterNames = (stamped ?? '').split(',').map((name) => name.trim());
      expect(afterNames.slice(0, names.length)).toEqual(names);
      expect(afterNames).toContain(SHARE_SEARCH_HEADER);
      expect(afterHeaders.get(`x-middleware-request-${SHARE_SEARCH_HEADER}`)).toBe('');
      expect(path.includes('promo_phase')).toBe(false);
    },
  );

  it('keeps / in English, /fr in French, and redirects /en back to /', () => {
    const root = middleware(page('/'));
    const french = middleware(page('/fr'));
    const prefixedDefault = middleware(page('/en'));
    expect(root.headers.get('location')).toBeNull();
    expect(root.headers.get('x-middleware-request-x-next-intl-locale')).toBe('en');
    expect(french.headers.get('location')).toBeNull();
    expect(french.headers.get('x-middleware-request-x-next-intl-locale')).toBe('fr');
    expect(french.headers.get('link')).toContain('hreflang="fr"');
    expect(prefixedDefault.status).toBeGreaterThanOrEqual(300);
    expect(prefixedDefault.status).toBeLessThan(400);
    const location = prefixedDefault.headers.get('location');
    expect(location).toBe(intl(page('/en')).headers.get('location'));
    expect(new URL(location ?? '', 'https://www.villagehale.com').pathname).toBe('/');
  });
});
