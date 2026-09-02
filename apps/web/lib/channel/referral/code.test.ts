import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REFERRAL_CODE_PATTERN, isReferralCode, referralCode, referralLink } from './code';

const KEY_A = Buffer.alloc(32, 7).toString('base64');
const KEY_B = Buffer.alloc(32, 9).toString('base64');
const FAMILY = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const OTHER_FAMILY = '9c858901-8a57-4791-81fe-4c455b099bc9';

/** The grammar the /text page and the intake parser both enforce on a `?s=` value
 * (apps/site/lib/text-entry.ts SOURCE_CODE_PATTERN). Restated here rather than imported
 * because apps/site is a separate build: this test is the thing that would catch the two
 * drifting apart. */
const SITE_SOURCE_CODE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SITE_SOURCE_CODE_MAX_LENGTH = 48;

describe('referralCode', () => {
  const prev = process.env.APP_ENCRYPTION_KEY;
  beforeEach(() => {
    process.env.APP_ENCRYPTION_KEY = KEY_A;
  });
  afterEach(() => {
    process.env.APP_ENCRYPTION_KEY = prev;
  });

  it('is DETERMINISTIC — a link forwarded today still attributes next month', () => {
    expect(referralCode(FAMILY)).toBe(referralCode(FAMILY));
  });

  it('separates families: two families never share a code', () => {
    expect(referralCode(FAMILY)).not.toBe(referralCode(OTHER_FAMILY));
  });

  it('leaks no part of the family UUID (rule #1 — this string is the most-copied id Hale emits)', () => {
    const code = referralCode(FAMILY);
    // The whole id, and every hex run inside it: an encoding that happened to carry a
    // chunk of the uuid would pass a naive "does it contain the id" check.
    expect(code).not.toContain(FAMILY);
    for (const segment of FAMILY.split('-')) {
      expect(code).not.toContain(segment);
    }
    // Positive control: the assertions above can only fail open if the code is empty.
    expect(code.length).toBeGreaterThan(('friend-').length);
  });

  it('is keyed — the same family under a different APP_ENCRYPTION_KEY is a different code', () => {
    const underA = referralCode(FAMILY);
    process.env.APP_ENCRYPTION_KEY = KEY_B;
    expect(referralCode(FAMILY)).not.toBe(underA);
  });

  it('is derived from a subkey, not the raw key: an attacker holding a code cannot replay it as the phone index', async () => {
    const { phoneBlindIndex } = await import('~/lib/crypto/blind-index');
    // Same key material, same input, different HKDF context label → different digest.
    // If the labels were shared, one surface's hash would probe the other's.
    expect(referralCode(FAMILY)).not.toContain(phoneBlindIndex(FAMILY).slice(0, 12));
  });

  it('travels the existing ?s= funnel: matches the site source-code grammar', () => {
    const code = referralCode(FAMILY);
    expect(code).toMatch(SITE_SOURCE_CODE_PATTERN);
    expect(code.length).toBeLessThanOrEqual(SITE_SOURCE_CODE_MAX_LENGTH);
    expect(code).toMatch(REFERRAL_CODE_PATTERN);
  });

  it('refuses to guess when the key is missing rather than emitting a weak code', () => {
    process.env.APP_ENCRYPTION_KEY = undefined;
    expect(() => referralCode(FAMILY)).toThrow(/APP_ENCRYPTION_KEY/);
  });
});

describe('isReferralCode', () => {
  it('recognises a referral tag, case-insensitively (a forwarded link can be retyped)', () => {
    expect(isReferralCode('friend-0123456789ab')).toBe(true);
    expect(isReferralCode('FRIEND-0123456789AB')).toBe(true);
  });

  it('rejects the QR venue codes, which resolve through the registry instead', () => {
    expect(isReferralCode('earlyon-richmondhill')).toBe(false);
    expect(isReferralCode('LIBRARY')).toBe(false);
  });

  it('rejects near-misses rather than storing a tag that resolves to nobody', () => {
    expect(isReferralCode('friend-0123456789a')).toBe(false); // one hex short
    expect(isReferralCode('friend-0123456789abc')).toBe(false); // one hex long
    expect(isReferralCode('friend-0123456789zz')).toBe(false); // not hex
    expect(isReferralCode('friends-0123456789ab')).toBe(false); // wrong prefix
    expect(isReferralCode('friend0123456789ab')).toBe(false); // no separator
  });
});

describe('referralLink', () => {
  const prev = process.env.APP_ENCRYPTION_KEY;
  beforeEach(() => {
    process.env.APP_ENCRYPTION_KEY = KEY_A;
  });
  afterEach(() => {
    process.env.APP_ENCRYPTION_KEY = prev;
  });

  it('points a stranger at /text on the marketing site, never at the app sign-in', () => {
    expect(referralLink(FAMILY)).toBe(
      `https://www.villagehale.com/text?s=${referralCode(FAMILY)}`,
    );
  });

  it('is short enough that the whole forwardable message fits two SMS segments', () => {
    // 306 GSM-7 characters is the ceiling (MAX_REPLY_SEGMENTS); the link plus the 120
    // the forward line may use has to leave a parent's own sentence room.
    expect(referralLink(FAMILY).length).toBeLessThan(60);
  });
});
