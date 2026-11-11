import { createHmac } from 'node:crypto';

/**
 * RFC 6238 TOTP. Generated only inside a Browser Use login run and passed as a
 * secret alias. The seed never enters a prompt, log or audit row.
 */

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function parseTotpSeed(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let secret = trimmed;
  if (/^otpauth:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      secret = url.searchParams.get('secret') ?? '';
    } catch {
      return null;
    }
  }
  const compact = secret.replace(/\s+/g, '').toUpperCase().replace(/=+$/, '');
  if (compact.length < 8 || compact.length > 128) return null;
  if (![...compact].every((c) => BASE32.includes(c))) return null;
  return compact;
}

function base32ToBytes(secret: string): Buffer {
  let bits = '';
  for (const c of secret) {
    const v = BASE32.indexOf(c);
    bits += v.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(Number.parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

/** Six-digit TOTP for `at` (default now), 30-second step, SHA-1. */
export function totpCode(secret: string, at: Date = new Date(), stepSeconds = 30): string {
  const counter = Math.floor(at.getTime() / 1000 / stepSeconds);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const hmac = createHmac('sha1', base32ToBytes(secret)).update(buf).digest();
  const offset = (hmac.at(-1) ?? 0) & 0x0f;
  const bin =
    (((hmac[offset] ?? 0) & 0x7f) << 24) |
    ((hmac[offset + 1] ?? 0) << 16) |
    ((hmac[offset + 2] ?? 0) << 8) |
    (hmac[offset + 3] ?? 0);
  return String(bin % 1_000_000).padStart(6, '0');
}
