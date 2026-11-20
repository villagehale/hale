import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { SealedBlobRejected } from '~/lib/crypto/string-cipher';

const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Encrypt a UTF-8 secret under a family's 32-byte DEK. Never log the result's meaning. */
export function encryptWithDek(dek: Buffer, plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', dek, iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
}

export function decryptWithDek(dek: Buffer, blob: string): string {
  const bytes = Buffer.from(blob, 'base64');
  const iv = bytes.subarray(0, IV_BYTES);
  const authTag = bytes.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = bytes.subarray(IV_BYTES + TAG_BYTES);
  try {
    const decipher = createDecipheriv('aes-256-gcm', dek, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch (err) {
    throw new SealedBlobRejected('sealed blob rejected', { cause: err });
  }
}
