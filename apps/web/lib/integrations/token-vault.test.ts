import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decryptTokens, encryptTokens, type OAuthTokens } from './token-vault';

// Two distinct 32-byte keys, base64-encoded (AES-256).
const KEY_A = Buffer.alloc(32, 1).toString('base64');
const KEY_B = Buffer.alloc(32, 2).toString('base64');

const TOKENS: OAuthTokens = {
  accessToken: 'ya29.a0-access-token',
  refreshToken: '1//refresh-token',
  expiresAt: 1893456000000,
  scope: 'https://www.googleapis.com/auth/calendar.readonly',
  tokenType: 'Bearer',
};

describe('integration token vault (AES-256-GCM)', () => {
  const prev = process.env.APP_ENCRYPTION_KEY;
  beforeEach(() => {
    process.env.APP_ENCRYPTION_KEY = KEY_A;
  });
  afterEach(() => {
    process.env.APP_ENCRYPTION_KEY = prev;
  });

  it('round-trips a token set through encrypt → decrypt', () => {
    expect(decryptTokens(encryptTokens(TOKENS))).toEqual(TOKENS);
  });

  it('produces different ciphertext each call for the same input (random IV)', () => {
    expect(encryptTokens(TOKENS)).not.toBe(encryptTokens(TOKENS));
  });

  it('rejects a tampered ciphertext (GCM auth tag catches the flip)', () => {
    const bytes = Buffer.from(encryptTokens(TOKENS), 'base64');
    bytes[bytes.length - 1] ^= 0xff; // flip the last ciphertext byte
    expect(() => decryptTokens(bytes.toString('base64'))).toThrow();
  });

  it('cannot be decrypted with a different key', () => {
    const blob = encryptTokens(TOKENS);
    process.env.APP_ENCRYPTION_KEY = KEY_B;
    expect(() => decryptTokens(blob)).toThrow();
  });

  it('throws a clear error when APP_ENCRYPTION_KEY is missing or the wrong length', () => {
    process.env.APP_ENCRYPTION_KEY = '';
    expect(() => encryptTokens(TOKENS)).toThrow(/APP_ENCRYPTION_KEY/);
    process.env.APP_ENCRYPTION_KEY = Buffer.alloc(16, 1).toString('base64'); // 16 bytes ≠ 32
    expect(() => encryptTokens(TOKENS)).toThrow(/APP_ENCRYPTION_KEY/);
  });
});
