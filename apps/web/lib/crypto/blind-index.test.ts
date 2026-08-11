import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encryptString } from './string-cipher';
import { emailBlindIndex, phoneBlindIndex } from './blind-index';

const KEY_A = Buffer.alloc(32, 1).toString('base64');
const KEY_B = Buffer.alloc(32, 2).toString('base64');
const PHONE = '+15195551234';

describe('phoneBlindIndex (keyed HMAC blind index)', () => {
  const prev = process.env.APP_ENCRYPTION_KEY;
  beforeEach(() => {
    process.env.APP_ENCRYPTION_KEY = KEY_A;
  });
  afterEach(() => {
    process.env.APP_ENCRYPTION_KEY = prev;
  });

  it('is DETERMINISTIC — same number maps to the same index (so equality lookup works)', () => {
    expect(phoneBlindIndex(PHONE)).toBe(phoneBlindIndex(PHONE));
  });

  it('unlike encryption, is queryable: the index is stable while ciphertext is not', () => {
    // The whole point of a blind index vs. the encrypted blob: encryption uses a
    // random IV (never equal), so an inbound `From` can only be resolved by the
    // deterministic index.
    expect(encryptString(PHONE)).not.toBe(encryptString(PHONE));
    expect(phoneBlindIndex(PHONE)).toBe(phoneBlindIndex(PHONE));
  });

  it('is a 64-char hex digest and never the plaintext number', () => {
    const idx = phoneBlindIndex(PHONE);
    expect(idx).toMatch(/^[0-9a-f]{64}$/);
    expect(idx).not.toContain(PHONE);
  });

  it('maps different numbers to different indexes', () => {
    expect(phoneBlindIndex(PHONE)).not.toBe(phoneBlindIndex('+15195551235'));
  });

  it('is keyed — a different APP_ENCRYPTION_KEY yields a different index', () => {
    const withA = phoneBlindIndex(PHONE);
    process.env.APP_ENCRYPTION_KEY = KEY_B;
    expect(phoneBlindIndex(PHONE)).not.toBe(withA);
  });

  it('is separated from the encryption key — the index is NOT a raw HMAC under the AES key', () => {
    // Key separation: the blind-index key is HKDF-derived, so the index differs from
    // a naive HMAC(APP_ENCRYPTION_KEY, phone). A leaked index can't be replayed as an
    // encryption-key oracle.
    const naive = createHmac('sha256', Buffer.from(KEY_A, 'base64')).update(PHONE).digest('hex');
    expect(phoneBlindIndex(PHONE)).not.toBe(naive);
  });

  it('throws a clear error when APP_ENCRYPTION_KEY is missing', () => {
    process.env.APP_ENCRYPTION_KEY = '';
    expect(() => phoneBlindIndex(PHONE)).toThrow(/APP_ENCRYPTION_KEY/);
  });
});

describe('emailBlindIndex', () => {
  const prev = process.env.APP_ENCRYPTION_KEY;
  const EMAIL = 'sam@example.com';
  beforeEach(() => {
    process.env.APP_ENCRYPTION_KEY = KEY_A;
  });
  afterEach(() => {
    process.env.APP_ENCRYPTION_KEY = prev;
  });

  it('is deterministic and never carries the plaintext address', () => {
    expect(emailBlindIndex(EMAIL)).toBe(emailBlindIndex(EMAIL));
    expect(emailBlindIndex(EMAIL)).toMatch(/^[0-9a-f]{64}$/);
    expect(emailBlindIndex(EMAIL)).not.toContain('sam');
    expect(emailBlindIndex(EMAIL)).not.toContain('example.com');
  });

  it('maps different addresses to different indexes', () => {
    expect(emailBlindIndex(EMAIL)).not.toBe(emailBlindIndex('sam2@example.com'));
  });

  /** KEY SEPARATION: the two indexes derive from different HKDF labels, so a hash
   * harvested from one identifier space cannot be probed against the other. */
  it('derives a different subkey from the phone index for the same input', () => {
    expect(emailBlindIndex(EMAIL)).not.toBe(phoneBlindIndex(EMAIL));
  });

  it('is keyed — a different APP_ENCRYPTION_KEY yields a different index', () => {
    const withA = emailBlindIndex(EMAIL);
    process.env.APP_ENCRYPTION_KEY = KEY_B;
    expect(emailBlindIndex(EMAIL)).not.toBe(withA);
  });

  it('throws a clear error when APP_ENCRYPTION_KEY is missing', () => {
    process.env.APP_ENCRYPTION_KEY = '';
    expect(() => emailBlindIndex(EMAIL)).toThrow(/APP_ENCRYPTION_KEY/);
  });
});
