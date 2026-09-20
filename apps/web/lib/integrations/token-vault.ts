import { decryptString, encryptString } from '~/lib/crypto/string-cipher';

/**
 * Envelope-encryption for integration OAuth tokens, stored on
 * `integrations.oauth_tokens_encrypted`. A thin JSON wrapper over the generic
 * AES-256-GCM {@link encryptString} primitive (lib/crypto/string-cipher) — a
 * connector's tokens are among the most sensitive data we hold (rule #1), so
 * decryption fails loud on a tampered blob or wrong key.
 */
export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms when the access token expires. */
  expiresAt?: number;
  scope?: string;
  tokenType?: string;
}

/** Envelope-encrypt an OAuth token set → base64(iv ‖ authTag ‖ ciphertext). */
export function encryptTokens(tokens: OAuthTokens): string {
  return encryptString(JSON.stringify(tokens));
}

/**
 * WHERE a connector token lives, as data a parent can be shown — the fact the trail
 * sentence and the PIPEDA access export both rest on.
 *
 * It lives HERE, beside {@link encryptTokens}, so that changing where the token goes
 * means editing the same file that describes where it goes. Every field is a fact
 * about Hale's own custody and none of them is a secret: the key is named, never
 * read (rule #1).
 */
export interface TokenCustody {
  /** No broker ever holds this token — the spike's finding, stated as data. */
  holder: 'hale';
  store: 'integrations.oauth_tokens_encrypted';
  /** lib/crypto/string-cipher.ts — base64(iv ‖ authTag ‖ ciphertext). */
  envelope: 'aes-256-gcm';
  /** WHICH key, never the key. */
  key: 'APP_ENCRYPTION_KEY';
  /** Where the ciphertext rests, or 'unnamed' when no deployment declared one —
   * an absence said out loud rather than a region silently assumed (rule #11). */
  region: string;
}

/**
 * A function, not a constant: the env read happens at WRITE time, so a row records the
 * residency the deployment actually had when it stored that token, not the one the
 * module happened to load with.
 */
export function tokenCustody(): TokenCustody {
  return {
    holder: 'hale',
    store: 'integrations.oauth_tokens_encrypted',
    envelope: 'aes-256-gcm',
    key: 'APP_ENCRYPTION_KEY',
    // `||`, not `??`: the var ships in .env.example with no value, and an empty string
    // is not a region — it is the same absence, and it has to read as the same word.
    region: process.env.DATA_RESIDENCY_REGION || 'unnamed',
  };
}

/** Reverse of {@link encryptTokens}. Throws if the key is wrong or the blob was tampered. */
export function decryptTokens(blob: string): OAuthTokens {
  return JSON.parse(decryptString(blob)) as OAuthTokens;
}
