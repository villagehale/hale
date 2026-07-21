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

/** Reverse of {@link encryptTokens}. Throws if the key is wrong or the blob was tampered. */
export function decryptTokens(blob: string): OAuthTokens {
  return JSON.parse(decryptString(blob)) as OAuthTokens;
}
