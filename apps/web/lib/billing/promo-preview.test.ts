import { describe, expect, it } from 'vitest';
import {
  PROMO_PREVIEW_COOKIE,
  isPromoPreviewFamily,
  promoPreviewCookieFromHeader,
  promoPreviewFamilyIds,
  promoPreviewTokenFromSearch,
  promoPreviewTokenMatches,
  readPromoPreviewCookie,
  signPromoPreviewCookie,
  stripePaymentLinkUrl,
} from './promo-preview';

describe('promo preview allowlist', () => {
  it('is empty by default, so nobody is listed', () => {
    expect(promoPreviewFamilyIds({})).toEqual(new Set());
    expect(isPromoPreviewFamily('fam-1', {})).toBe(false);
    expect(isPromoPreviewFamily(null, { PROMO_PREVIEW_FAMILY_IDS: 'fam-1' })).toBe(false);
  });

  it('matches a listed family id and ignores surrounding space', () => {
    const env = { PROMO_PREVIEW_FAMILY_IDS: ' fam-a,fam-b , ' };
    expect(isPromoPreviewFamily('fam-a', env)).toBe(true);
    expect(isPromoPreviewFamily('fam-b', env)).toBe(true);
    expect(isPromoPreviewFamily('fam-c', env)).toBe(false);
  });
});

describe('promo preview token', () => {
  it('never matches when the env is empty', () => {
    expect(promoPreviewTokenMatches('secret', {})).toBe(false);
    expect(promoPreviewTokenMatches('', { PROMO_PREVIEW_TOKEN: 'secret' })).toBe(false);
    expect(promoPreviewTokenMatches(null, { PROMO_PREVIEW_TOKEN: 'secret' })).toBe(false);
  });

  it('matches the exact token from ?preview=', () => {
    const env = { PROMO_PREVIEW_TOKEN: 'preview-secret' };
    expect(promoPreviewTokenMatches('preview-secret', env)).toBe(true);
    expect(promoPreviewTokenMatches('nope', env)).toBe(false);
    expect(promoPreviewTokenFromSearch(new URLSearchParams('preview=preview-secret'))).toBe(
      'preview-secret',
    );
    expect(promoPreviewTokenFromSearch(new URLSearchParams('gclid=1'))).toBeNull();
  });
});

describe('promo preview cookie', () => {
  const env = { AUTH_SECRET: 'test-secret', PROMO_PREVIEW_TOKEN: 'preview-secret' };

  it('round-trips a signed cookie and expires', () => {
    const signed = signPromoPreviewCookie(env, { now: 1_000_000, ttlSeconds: 10 });
    expect(signed).toBeTruthy();
    expect(readPromoPreviewCookie(signed, env, { now: 1_000_000 })).toBe(true);
    expect(readPromoPreviewCookie(signed, env, { now: 1_000_000 + 11_000 })).toBe(false);
  });

  it('rejects a cookie signed with a different token or secret', () => {
    const signed = signPromoPreviewCookie(env);
    expect(readPromoPreviewCookie(signed, { ...env, PROMO_PREVIEW_TOKEN: 'other' })).toBe(false);
    expect(readPromoPreviewCookie(signed, { ...env, AUTH_SECRET: 'other' })).toBe(false);
    expect(signPromoPreviewCookie({ AUTH_SECRET: 'test-secret' })).toBeNull();
  });

  it('reads hale_promo_preview from a Cookie header', () => {
    const signed = signPromoPreviewCookie(env);
    expect(promoPreviewCookieFromHeader(`${PROMO_PREVIEW_COOKIE}=${signed}`)).toBe(signed);
    expect(promoPreviewCookieFromHeader('other=1')).toBeNull();
  });
});

describe('Stripe Payment Link URL', () => {
  it('reads STRIPE_PAYMENT_LINK_URL when set', () => {
    expect(stripePaymentLinkUrl({})).toBeNull();
    expect(stripePaymentLinkUrl({ STRIPE_PAYMENT_LINK_URL: ' https://buy.stripe.com/x ' })).toBe(
      'https://buy.stripe.com/x',
    );
  });
});
