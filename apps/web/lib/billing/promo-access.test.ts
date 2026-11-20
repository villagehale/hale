import { describe, expect, it } from 'vitest';
import {
  familyMayUseFoundingCheckout,
  newVisitorFoundingAllowed,
  unpaidPlanSurface,
} from './promo-access';
import { signPromoPreviewCookie } from './promo-preview';

const BEFORE = new Date('2026-11-16T12:00:00-05:00');
const AFTER = new Date('2027-01-01T00:00:00-05:00');

describe('familyMayUseFoundingCheckout', () => {
  it('refuses everyone when the live flag is off and the family is not listed', () => {
    expect(familyMayUseFoundingCheckout('fam-1', BEFORE, {})).toBe(false);
    expect(
      familyMayUseFoundingCheckout('fam-other', BEFORE, { PROMO_PREVIEW_FAMILY_IDS: 'fam-1' }),
    ).toBe(false);
  });

  it('lets a listed family through while the live flag stays off', () => {
    expect(
      familyMayUseFoundingCheckout('fam-1', BEFORE, { PROMO_PREVIEW_FAMILY_IDS: 'fam-1' }),
    ).toBe(true);
  });

  it('lets every family through when the live flag is on in the window', () => {
    expect(
      familyMayUseFoundingCheckout('fam-anyone', BEFORE, { HOLIDAY_PROMO_ENABLED: 'true' }),
    ).toBe(true);
  });

  it('refuses listed families after the cutoff', () => {
    expect(
      familyMayUseFoundingCheckout('fam-1', AFTER, {
        HOLIDAY_PROMO_ENABLED: 'true',
        PROMO_PREVIEW_FAMILY_IDS: 'fam-1',
      }),
    ).toBe(false);
  });
});

describe('unpaidPlanSurface', () => {
  it('is founding during the window for live and preview families', () => {
    expect(unpaidPlanSurface('fam-anyone', BEFORE, { HOLIDAY_PROMO_ENABLED: 'true' })).toBe(
      'founding',
    );
    expect(unpaidPlanSurface('fam-1', BEFORE, { PROMO_PREVIEW_FAMILY_IDS: 'fam-1' })).toBe(
      'founding',
    );
  });

  it('stays free (no list, no greyed monthly) when the flag is off and the family is not listed', () => {
    expect(unpaidPlanSurface('fam-other', BEFORE, { PROMO_PREVIEW_FAMILY_IDS: 'fam-1' })).toBe(
      'free',
    );
  });

  it('returns list monthly and annual after the cutoff when the live flag is on', () => {
    expect(unpaidPlanSurface('fam-anyone', AFTER, { HOLIDAY_PROMO_ENABLED: 'true' })).toBe('list');
  });
});

describe('newVisitorFoundingAllowed', () => {
  it('404s when flags are off and the token is missing or wrong', () => {
    expect(newVisitorFoundingAllowed(BEFORE, null, {})).toBe(false);
    expect(newVisitorFoundingAllowed(BEFORE, 'nope', { PROMO_PREVIEW_TOKEN: 'secret' })).toBe(
      false,
    );
  });

  it('lets testers in with the preview token while the flags stay off', () => {
    expect(newVisitorFoundingAllowed(BEFORE, 'secret', { PROMO_PREVIEW_TOKEN: 'secret' })).toBe(
      true,
    );
  });

  it('lets everyone in when both live flags are on', () => {
    expect(
      newVisitorFoundingAllowed(BEFORE, null, {
        HOLIDAY_PROMO_ENABLED: 'true',
        PROMO_NEW_VISITOR_CHECKOUT_ENABLED: 'true',
      }),
    ).toBe(true);
  });

  it('refuses the preview token after the cutoff', () => {
    expect(
      newVisitorFoundingAllowed(AFTER, 'secret', {
        HOLIDAY_PROMO_ENABLED: 'true',
        PROMO_NEW_VISITOR_CHECKOUT_ENABLED: 'true',
        PROMO_PREVIEW_TOKEN: 'secret',
      }),
    ).toBe(false);
  });

  it('lets testers in with the HttpOnly preview cookie while flags stay off', () => {
    const env = { AUTH_SECRET: 'test-secret', PROMO_PREVIEW_TOKEN: 'secret' };
    const cookie = signPromoPreviewCookie(env);
    expect(newVisitorFoundingAllowed(BEFORE, null, env, cookie)).toBe(true);
    expect(newVisitorFoundingAllowed(BEFORE, null, env, 'tampered')).toBe(false);
  });
});
