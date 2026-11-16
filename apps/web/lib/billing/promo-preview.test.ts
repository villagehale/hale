import { describe, expect, it } from 'vitest';
import {
  isPromoPreviewFamily,
  promoPreviewFamilyIds,
  promoPreviewTokenFromSearch,
  promoPreviewTokenMatches,
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

describe('Stripe Payment Link URL', () => {
  it('reads STRIPE_PAYMENT_LINK_URL when set', () => {
    expect(stripePaymentLinkUrl({})).toBeNull();
    expect(stripePaymentLinkUrl({ STRIPE_PAYMENT_LINK_URL: ' https://buy.stripe.com/x ' })).toBe(
      'https://buy.stripe.com/x',
    );
  });
});
