import { createHmac, hkdfSync } from 'node:crypto';

/**
 * Deterministic keyed blind index for a phone number. AES-256-GCM (string-cipher)
 * uses a random IV, so two encryptions of the same number never match — the encrypted
 * blob is not queryable by equality. The inbound-SMS webhook (A3) must resolve an
 * incoming `From` number → parent, which needs an equality-searchable column. This is
 * that column's value: HMAC-SHA256 of the CANONICAL E.164 (callers must normalize via
 * normalizePhoneE164 first), so the same number always yields the same index while the
 * raw number stays out of the DB.
 *
 * KEY SEPARATION without a new provisioned secret: the HMAC key is HKDF-derived from
 * APP_ENCRYPTION_KEY under a fixed context label, so it is distinct from the AES
 * encryption key (a leaked index is not an oracle for the encryption key) yet needs no
 * separate pepper env — the blind index works the moment APP_ENCRYPTION_KEY is set,
 * with no extra provisioning gate.
 */

const KEY_BYTES = 32;
/** Context label separating the blind-index subkey from the encryption key. Bumping
 * the version means a full re-index (every stored hash changes), so it is pinned. */
const BLIND_INDEX_INFO = 'hale-phone-blind-index-v1';

function loadKeyMaterial(): Buffer {
  const raw = process.env.APP_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error('APP_ENCRYPTION_KEY is not set — cannot compute a phone blind index');
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `APP_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes (got ${key.length}) — generate one with \`openssl rand -base64 32\``,
    );
  }
  return key;
}

/** HKDF-derived HMAC key, distinct from the AES encryption key (key separation). */
function blindIndexKey(): Buffer {
  return Buffer.from(
    hkdfSync('sha256', loadKeyMaterial(), Buffer.alloc(0), BLIND_INDEX_INFO, KEY_BYTES),
  );
}

/**
 * The blind-index value for a CANONICAL E.164 number (as returned by
 * normalizePhoneE164). Deterministic hex digest — store it in
 * parent_channels.phone_e164_hash and look an inbound number up by equality.
 */
export function phoneBlindIndex(e164Canonical: string): string {
  return createHmac('sha256', blindIndexKey()).update(e164Canonical).digest('hex');
}
