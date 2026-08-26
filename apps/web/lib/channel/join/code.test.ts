import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { JOIN_CODE_PATTERN, isJoinCode, joinLink, joinTokenHash, mintJoinCode } from './code';

/**
 * The grammar the /text page and the intake parser both enforce on a `?s=` value
 * (apps/site/lib/text-entry.ts SOURCE_CODE_PATTERN). Restated here rather than imported
 * because apps/site is a separate build: this test is the thing that would catch the two
 * drifting apart — a base64url token would silently fail `parseSourceCode` and the link
 * would open a page that pre-writes nothing.
 */
const SITE_SOURCE_CODE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SITE_SOURCE_CODE_MAX_LENGTH = 48;

describe('mintJoinCode', () => {
  it('is RANDOM, not derived — two mints for the same family never collide', () => {
    const codes = new Set(Array.from({ length: 50 }, () => mintJoinCode()));
    expect(codes.size).toBe(50);
  });

  it('travels the existing ?s= funnel: matches the site source-code grammar', () => {
    const code = mintJoinCode();
    expect(code).toMatch(SITE_SOURCE_CODE_PATTERN);
    expect(code.length).toBeLessThanOrEqual(SITE_SOURCE_CODE_MAX_LENGTH);
    expect(code).toMatch(JOIN_CODE_PATTERN);
    expect(isJoinCode(code)).toBe(true);
  });

  it('carries at least 128 bits — whoever holds it gets co-parent access, so it must not be guessable', () => {
    expect(mintJoinCode().replace('join-', '')).toHaveLength(32);
  });
});

describe('isJoinCode', () => {
  it('is a SHAPE test, so a stale or forged code is recognised and then simply resolves to nothing', () => {
    expect(isJoinCode('join-0123456789abcdef0123456789abcdef')).toBe(true);
    expect(isJoinCode('JOIN-0123456789ABCDEF0123456789ABCDEF')).toBe(true);
  });

  it('does not claim the other tags that ride the same funnel', () => {
    expect(isJoinCode('friend-0123456789ab')).toBe(false);
    expect(isJoinCode('earlyon-richmondhill')).toBe(false);
    expect(isJoinCode('join-short')).toBe(false);
    expect(isJoinCode('join-0123456789abcdef0123456789abcdefff')).toBe(false);
  });
});

describe('joinTokenHash', () => {
  it('stores a digest, never the token: a DB read cannot reconstruct a usable link (rule #1)', () => {
    const code = mintJoinCode();
    const hash = joinTokenHash(code);
    expect(hash).not.toContain(code);
    expect(hash).not.toContain(code.replace('join-', ''));
    expect(hash).toBe(createHash('sha256').update(code.toLowerCase()).digest('hex'));
  });

  it('is case-insensitive on the way in — a forwarded link may arrive shouted', () => {
    const code = mintJoinCode();
    expect(joinTokenHash(code.toUpperCase())).toBe(joinTokenHash(code));
  });
});

describe('joinLink', () => {
  it('points at the marketing /text funnel, never the app (a stranger has no account)', () => {
    const code = mintJoinCode();
    expect(joinLink(code)).toBe(`https://www.villagehale.com/text?s=${code}`);
  });
});
