import { NextResponse } from 'next/server';
import { describe, expect, it } from 'vitest';
import { stampShareSearch } from '../../middleware';
import { SHARE_SEARCH_HEADER } from './share-search-header';

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
