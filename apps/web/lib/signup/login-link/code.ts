import { createHash, randomBytes } from 'node:crypto';
import { appBaseUrl } from '~/lib/cron/email-compliance';

/** ~10 URL-safe base62 characters, CSPRNG, unbiased. */
export const LOGIN_CODE_LENGTH = 10;
export const LOGIN_CODE_TTL_MS = 30 * 60_000;
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
/** Largest multiple of 62 that fits in a byte, so `b % 62` stays unbiased. */
const REJECT_AT = 62 * 4;

export function newLoginCode(): string {
  let out = '';
  while (out.length < LOGIN_CODE_LENGTH) {
    const b = randomBytes(1)[0];
    if (b === undefined || b >= REJECT_AT) continue;
    out += ALPHABET[b % 62];
  }
  return out;
}

export function hashLoginCode(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex');
}

/** Public parent URL on the existing app host. Never a login subdomain. */
export function loginLinkUrl(code: string): string {
  return `${appBaseUrl().replace(/\/$/, '')}/l/${encodeURIComponent(code)}`;
}

export function loginLinkExpiresAt(now: Date): Date {
  return new Date(now.getTime() + LOGIN_CODE_TTL_MS);
}
