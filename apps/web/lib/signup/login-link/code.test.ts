import { describe, expect, it } from 'vitest';
import {
  LOGIN_CODE_LENGTH,
  LOGIN_CODE_TTL_MS,
  hashLoginCode,
  loginLinkExpiresAt,
  loginLinkUrl,
  newLoginCode,
} from './code';

describe('provider login codes', () => {
  it('mints ~10 URL-safe base62 characters from CSPRNG', () => {
    const code = newLoginCode();
    expect(code).toMatch(/^[0-9A-Za-z]{10}$/);
    expect(code).toHaveLength(LOGIN_CODE_LENGTH);
    const again = newLoginCode();
    expect(again).not.toBe(code);
  });

  it('stores only the sha256 digest', () => {
    const code = 'AbCdef1234';
    const digest = hashLoginCode(code);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).toBe(hashLoginCode(code));
    expect(digest).not.toBe(code);
    expect(digest).not.toBe(hashLoginCode('AbCdef1235'));
  });

  it('builds the app-host /l/<code> URL, never a login subdomain', () => {
    expect(loginLinkUrl('AbCdef1234')).toBe('https://app.villagehale.com/l/AbCdef1234');
    expect(loginLinkUrl('AbCdef1234')).not.toContain('login.villagehale.com');
  });

  it('expires in 30 minutes', () => {
    const now = new Date('2026-12-01T12:00:00.000Z');
    expect(loginLinkExpiresAt(now).toISOString()).toBe('2026-12-01T12:30:00.000Z');
    expect(LOGIN_CODE_TTL_MS).toBe(30 * 60_000);
  });
});
