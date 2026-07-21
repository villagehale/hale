import { createHash, randomInt, timingSafeEqual } from 'node:crypto';

/**
 * OTP primitives for phone verification (VIL-212). We own the code (one vendor
 * path): generate a 6-digit code, store ONLY its SHA-256 hash (never the code —
 * rule #1, mirroring magic_link_tokens), and verify by constant-time hash compare.
 * The lifecycle math (expiry, lockout, resend cooldown) lives here as pure
 * predicates so it is unit-testable without a database.
 */

/** A code is valid for 10 minutes — short, since it authorises a channel verify. */
export const OTP_TTL_MS = 10 * 60 * 1000;
/** Wrong guesses before the code is locked (dead until a fresh send). */
export const OTP_MAX_ATTEMPTS = 3;
/** Minimum gap between two sends to the same enrolment. */
export const OTP_RESEND_COOLDOWN_MS = 60 * 1000;

/** A cryptographically-random, zero-padded 6-digit code. */
export function generateOtpCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/** SHA-256 hex of a code — the only representation stored at rest. */
export function hashOtpCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

/** Constant-time compare of a candidate code against a stored hash. */
export function verifyOtpCode(candidate: string, storedHash: string): boolean {
  // A real code is 6 chars — reject implausibly long input in O(1) before hashing,
  // so an authed caller can't drive per-request SHA work with a huge payload.
  if (candidate.length > 12) return false;
  const candidateHash = Buffer.from(hashOtpCode(candidate), 'hex');
  let stored: Buffer;
  try {
    stored = Buffer.from(storedHash, 'hex');
  } catch {
    return false;
  }
  if (stored.length !== candidateHash.length) return false;
  return timingSafeEqual(candidateHash, stored);
}

export function isOtpExpired(expiresAt: Date, now: Date = new Date()): boolean {
  return now.getTime() >= expiresAt.getTime();
}

export function isOtpLockedOut(attemptCount: number): boolean {
  return attemptCount >= OTP_MAX_ATTEMPTS;
}

export function isResendInCooldown(lastSentAt: Date, now: Date = new Date()): boolean {
  return now.getTime() - lastSentAt.getTime() < OTP_RESEND_COOLDOWN_MS;
}
