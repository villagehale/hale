import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Envelope-encryption for a single secret string. AES-256-GCM keyed by
 * APP_ENCRYPTION_KEY (a 32-byte key, base64). GCM is authenticated: a tampered blob
 * or wrong key fails `final()` rather than returning garbage — so decryption fails
 * loud (rule #1). This is the generic primitive extracted from the integration
 * token vault; the OAuth-token wrapper (token-vault.ts) and the phone-channel store
 * (parent_channels / phone_verifications) both encrypt through it.
 *
 * Blob layout (then base64): iv(12) ‖ authTag(16) ‖ ciphertext.
 */

const IV_BYTES = 12; // GCM standard nonce length
const KEY_BYTES = 32; // AES-256
const TAG_BYTES = 16;

function loadKey(): Buffer {
  const raw = process.env.APP_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error('APP_ENCRYPTION_KEY is not set — cannot encrypt/decrypt secrets');
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `APP_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes (got ${key.length}) — generate one with \`openssl rand -base64 32\``,
    );
  }
  return key;
}

/** Envelope-encrypt a UTF-8 string → base64(iv ‖ authTag ‖ ciphertext). */
export function encryptString(plaintext: string): string {
  const key = loadKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
}

/** Reverse of {@link encryptString}. Throws if the key is wrong or the blob was tampered. */
export function decryptString(blob: string): string {
  const key = loadKey();
  const bytes = Buffer.from(blob, 'base64');
  const iv = bytes.subarray(0, IV_BYTES);
  const authTag = bytes.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = bytes.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}
