import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decryptString, encryptString } from './string-cipher';

// Two distinct 32-byte keys, base64-encoded (AES-256).
const KEY_A = Buffer.alloc(32, 1).toString('base64');
const KEY_B = Buffer.alloc(32, 2).toString('base64');

const PLAINTEXT = '+15195551234';

describe('string cipher (AES-256-GCM)', () => {
  const prev = process.env.APP_ENCRYPTION_KEY;
  beforeEach(() => {
    process.env.APP_ENCRYPTION_KEY = KEY_A;
  });
  afterEach(() => {
    process.env.APP_ENCRYPTION_KEY = prev;
  });

  it('round-trips a string through encrypt → decrypt', () => {
    expect(decryptString(encryptString(PLAINTEXT))).toBe(PLAINTEXT);
  });

  it('round-trips an empty string', () => {
    expect(decryptString(encryptString(''))).toBe('');
  });

  it('produces different ciphertext each call for the same input (random IV)', () => {
    expect(encryptString(PLAINTEXT)).not.toBe(encryptString(PLAINTEXT));
  });

  it('rejects a tampered ciphertext (GCM auth tag catches the flip)', () => {
    const bytes = Buffer.from(encryptString(PLAINTEXT), 'base64');
    const last = bytes.length - 1;
    bytes[last] = ((bytes[last] ?? 0) ^ 0xff) & 0xff;
    expect(() => decryptString(bytes.toString('base64'))).toThrow();
  });

  it('cannot be decrypted with a different key', () => {
    const blob = encryptString(PLAINTEXT);
    process.env.APP_ENCRYPTION_KEY = KEY_B;
    expect(() => decryptString(blob)).toThrow();
  });

  it('throws a clear error when APP_ENCRYPTION_KEY is missing or the wrong length', () => {
    process.env.APP_ENCRYPTION_KEY = '';
    expect(() => encryptString(PLAINTEXT)).toThrow(/APP_ENCRYPTION_KEY/);
    process.env.APP_ENCRYPTION_KEY = Buffer.alloc(16, 1).toString('base64'); // 16 ≠ 32
    expect(() => encryptString(PLAINTEXT)).toThrow(/APP_ENCRYPTION_KEY/);
  });
});
