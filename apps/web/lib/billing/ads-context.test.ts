import { describe, expect, it } from 'vitest';
import {
  adsContextFromRequest,
  adsContextFromStripeMetadata,
  adsContextToStripeMetadata,
  clientIpFromHeaders,
  fbcFromFbclid,
} from './ads-context.js';

describe('adsContextFromRequest', () => {
  it('reads _fbp/_fbc, IP, and user agent, and builds fbc from fbclid when the cookie is missing', () => {
    const headers = new Headers({
      'x-forwarded-for': '203.0.113.9, 10.0.0.1',
      'user-agent': 'Mozilla/5.0 HaleTest',
    });
    const context = adsContextFromRequest({
      cookieHeader: '_fbp=fb.1.1.cookie; other=x',
      headers,
      fbclid: 'ClickFace',
      nowMs: 1_700_000_000_000,
    });
    expect(context).toEqual({
      fbp: 'fb.1.1.cookie',
      fbc: 'fb.1.1700000000000.ClickFace',
      clientIp: '203.0.113.9',
      clientUserAgent: 'Mozilla/5.0 HaleTest',
    });
    expect(adsContextFromStripeMetadata(adsContextToStripeMetadata(context))).toEqual(context);
  });

  it('builds fbc from metadata fbclid when the cookie value was not stored', () => {
    const context = adsContextFromStripeMetadata({
      fbp: 'fb.1.1.cookie',
      fbclid: 'ClickFace',
    });
    expect(context.fbp).toBe('fb.1.1.cookie');
    expect(context.fbc).toMatch(/^fb\.1\.\d+\.ClickFace$/);
  });

  it('prefers the _fbc cookie over a constructed fbc', () => {
    const context = adsContextFromRequest({
      cookieHeader: '_fbc=fb.1.1.fromcookie',
      fbclid: 'ClickFace',
      nowMs: 1,
    });
    expect(context.fbc).toBe('fb.1.1.fromcookie');
  });
});

describe('clientIpFromHeaders', () => {
  it('uses the first forwarded hop', () => {
    expect(clientIpFromHeaders(new Headers({ 'x-vercel-forwarded-for': '198.51.100.2' }))).toBe(
      '198.51.100.2',
    );
  });
});

describe('fbcFromFbclid', () => {
  it('matches Meta’s fb.1.<milliseconds>.<fbclid> form', () => {
    expect(fbcFromFbclid('AbC', 1_700_000_000_000)).toBe('fb.1.1700000000000.AbC');
  });
});
