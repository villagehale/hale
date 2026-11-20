import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { SealedBlobRejected } from '~/lib/crypto/string-cipher';

/**
 * Small KMS interface for wrapping per-family DEKs. The env implementation
 * uses PROVIDER_CREDENTIALS_MASTER_KEY (32-byte AES-256, base64). A real KMS
 * can replace this without changing the table: `master_key_version` names
 * which wrapping key sealed the blob.
 */

const IV_BYTES = 12;
const KEY_BYTES = 32;
const TAG_BYTES = 16;
export const PROVIDER_CREDENTIALS_MASTER_KEY_ENV = 'PROVIDER_CREDENTIALS_MASTER_KEY';
export const CURRENT_MASTER_KEY_VERSION = 1;

export interface CredentialKms {
  readonly masterKeyVersion: number;
  wrap(dek: Buffer): string;
  unwrap(wrapped: string, masterKeyVersion: number): Buffer;
}

function loadMasterKey(env: Record<string, string | undefined>): Buffer {
  const raw = env[PROVIDER_CREDENTIALS_MASTER_KEY_ENV];
  if (!raw) {
    throw new Error('PROVIDER_CREDENTIALS_MASTER_KEY is not set — cannot wrap credentials');
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `PROVIDER_CREDENTIALS_MASTER_KEY must decode to ${KEY_BYTES} bytes (got ${key.length})`,
    );
  }
  return key;
}

function seal(key: Buffer, plaintext: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
}

function open(key: Buffer, blob: string): Buffer {
  const bytes = Buffer.from(blob, 'base64');
  const iv = bytes.subarray(0, IV_BYTES);
  const authTag = bytes.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = bytes.subarray(IV_BYTES + TAG_BYTES);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (err) {
    throw new SealedBlobRejected('sealed blob rejected', { cause: err });
  }
}

export function envCredentialKms(
  env: Record<string, string | undefined> = process.env,
): CredentialKms {
  const key = loadMasterKey(env);
  return {
    masterKeyVersion: CURRENT_MASTER_KEY_VERSION,
    wrap(dek) {
      if (dek.length !== KEY_BYTES) throw new Error('DEK must be 32 bytes');
      return seal(key, dek);
    },
    unwrap(wrapped, masterKeyVersion) {
      if (masterKeyVersion !== CURRENT_MASTER_KEY_VERSION) {
        throw new SealedBlobRejected('unknown master key version');
      }
      const dek = open(key, wrapped);
      if (dek.length !== KEY_BYTES) throw new SealedBlobRejected('unwrapped DEK is the wrong size');
      return dek;
    },
  };
}

export function newFamilyDek(): Buffer {
  return randomBytes(KEY_BYTES);
}
