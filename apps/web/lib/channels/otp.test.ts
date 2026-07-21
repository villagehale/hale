import { describe, expect, it } from 'vitest';
import {
  OTP_MAX_ATTEMPTS,
  OTP_RESEND_COOLDOWN_MS,
  OTP_TTL_MS,
  generateOtpCode,
  hashOtpCode,
  isOtpExpired,
  isOtpLockedOut,
  isResendInCooldown,
  verifyOtpCode,
} from './otp';

describe('generateOtpCode', () => {
  it('is always a zero-padded 6-digit string', () => {
    for (let i = 0; i < 500; i++) {
      const code = generateOtpCode();
      expect(code).toMatch(/^\d{6}$/);
    }
  });

  it('varies across calls (not a constant)', () => {
    const codes = new Set(Array.from({ length: 50 }, () => generateOtpCode()));
    expect(codes.size).toBeGreaterThan(1);
  });
});

describe('hashOtpCode', () => {
  it('is a deterministic 64-char hex digest, never the code itself', () => {
    const h = hashOtpCode('123456');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).toBe(hashOtpCode('123456'));
    expect(h).not.toBe('123456');
  });

  it('differs for different codes', () => {
    expect(hashOtpCode('123456')).not.toBe(hashOtpCode('123457'));
  });
});

describe('verifyOtpCode', () => {
  it('accepts the right code against its hash and rejects a wrong one', () => {
    const hash = hashOtpCode('428913');
    expect(verifyOtpCode('428913', hash)).toBe(true);
    expect(verifyOtpCode('428914', hash)).toBe(false);
  });

  it('rejects a malformed comparison without throwing', () => {
    expect(verifyOtpCode('428913', 'not-a-hash')).toBe(false);
  });

  it('rejects an over-long candidate in O(1) (no unbounded hashing of an authed payload)', () => {
    const hash = hashOtpCode('428913');
    expect(verifyOtpCode('4'.repeat(5000), hash)).toBe(false);
  });
});

describe('isOtpExpired', () => {
  const expiresAt = new Date('2026-07-20T12:10:00.000Z');
  it('is false before expiry and true at/after it', () => {
    expect(isOtpExpired(expiresAt, new Date('2026-07-20T12:09:59.000Z'))).toBe(false);
    expect(isOtpExpired(expiresAt, new Date('2026-07-20T12:10:00.000Z'))).toBe(true);
    expect(isOtpExpired(expiresAt, new Date('2026-07-20T12:10:01.000Z'))).toBe(true);
  });
});

describe('isOtpLockedOut', () => {
  it('locks only once wrong attempts reach the ceiling', () => {
    expect(isOtpLockedOut(0)).toBe(false);
    expect(isOtpLockedOut(OTP_MAX_ATTEMPTS - 1)).toBe(false);
    expect(isOtpLockedOut(OTP_MAX_ATTEMPTS)).toBe(true);
    expect(isOtpLockedOut(OTP_MAX_ATTEMPTS + 1)).toBe(true);
  });
});

describe('isResendInCooldown', () => {
  const lastSentAt = new Date('2026-07-20T12:00:00.000Z');
  it('is true within the cooldown window and false after it', () => {
    expect(isResendInCooldown(lastSentAt, new Date(lastSentAt.getTime() + 1_000))).toBe(true);
    expect(
      isResendInCooldown(lastSentAt, new Date(lastSentAt.getTime() + OTP_RESEND_COOLDOWN_MS - 1)),
    ).toBe(true);
    expect(
      isResendInCooldown(lastSentAt, new Date(lastSentAt.getTime() + OTP_RESEND_COOLDOWN_MS)),
    ).toBe(false);
  });
});

describe('constants match the spec', () => {
  it('10-minute TTL, 3 attempts, 60s cooldown', () => {
    expect(OTP_TTL_MS).toBe(10 * 60 * 1000);
    expect(OTP_MAX_ATTEMPTS).toBe(3);
    expect(OTP_RESEND_COOLDOWN_MS).toBe(60 * 1000);
  });
});
