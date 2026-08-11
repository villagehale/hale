import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { isValidResendSignature, resendSignatureBase } from './signature';

/**
 * The signing secret Resend/Svix issues: `whsec_` + base64 of the raw key bytes.
 * These tests derive every expected signature the way the SPEC says to, never by
 * copying what the implementation produced.
 */
const SECRET_BYTES = Buffer.from('hale-inbound-email-test-key-32byt');
const SECRET = `whsec_${SECRET_BYTES.toString('base64')}`;

const ID = 'msg_2abcDEF';
const TIMESTAMP = '1786000000';
const PAYLOAD = '{"type":"email.received","data":{"email_id":"e1"}}';

/** The signature a correct signer produces, computed from the documented scheme. */
function sign(secret: string, id: string, timestamp: string, payload: string): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const digest = createHmac('sha256', key)
    .update(`${id}.${timestamp}.${payload}`, 'utf8')
    .digest('base64');
  return `v1,${digest}`;
}

const NOW = new Date(Number(TIMESTAMP) * 1000);

function valid(overrides: Partial<Parameters<typeof isValidResendSignature>[0]> = {}) {
  return isValidResendSignature({
    secret: SECRET,
    id: ID,
    timestamp: TIMESTAMP,
    signature: sign(SECRET, ID, TIMESTAMP, PAYLOAD),
    payload: PAYLOAD,
    now: NOW,
    ...overrides,
  });
}

describe('resendSignatureBase', () => {
  it('joins id, timestamp and the raw payload with dots, in that order', () => {
    expect(resendSignatureBase(ID, TIMESTAMP, PAYLOAD)).toBe(`${ID}.${TIMESTAMP}.${PAYLOAD}`);
  });
});

describe('isValidResendSignature', () => {
  it('accepts a signature computed over the documented base string', () => {
    expect(valid()).toBe(true);
  });

  it('rejects a payload altered after signing', () => {
    expect(valid({ payload: `${PAYLOAD} ` })).toBe(false);
  });

  it('rejects a signature made with a different secret', () => {
    const other = `whsec_${Buffer.from('a-completely-different-key-32byt').toString('base64')}`;
    expect(valid({ signature: sign(other, ID, TIMESTAMP, PAYLOAD) })).toBe(false);
  });

  it('rejects a signature bound to a different message id — no cross-message replay', () => {
    expect(valid({ signature: sign(SECRET, 'msg_other', TIMESTAMP, PAYLOAD) })).toBe(false);
  });

  it('rejects a missing signature header', () => {
    expect(valid({ signature: null })).toBe(false);
  });

  it('rejects a missing id or timestamp', () => {
    expect(valid({ id: null })).toBe(false);
    expect(valid({ timestamp: null })).toBe(false);
  });

  it('rejects garbage in the signature header without throwing', () => {
    expect(valid({ signature: 'not-a-signature' })).toBe(false);
    expect(valid({ signature: 'v1,' })).toBe(false);
    expect(valid({ signature: '' })).toBe(false);
  });

  /**
   * Svix sends a SPACE-SEPARATED list so a secret can be rotated without downtime:
   * during the overlap both the old and new signature ride on one header, and a
   * verifier that only reads the first would reject every request signed by the other.
   */
  it('accepts when the correct signature is any member of a space-separated list', () => {
    const good = sign(SECRET, ID, TIMESTAMP, PAYLOAD);
    expect(valid({ signature: `v1,AAAA ${good}` })).toBe(true);
    expect(valid({ signature: `${good} v1,AAAA` })).toBe(true);
  });

  it('ignores versions it does not understand rather than trusting them', () => {
    const digest = sign(SECRET, ID, TIMESTAMP, PAYLOAD).slice('v1,'.length);
    expect(valid({ signature: `v2,${digest}` })).toBe(false);
  });

  /**
   * A replay of a genuine request carries a genuine signature forever. The timestamp
   * is the only thing that bounds it, so it is verified — and it is verified as part
   * of the SIGNED base string, which is what stops an attacker from simply editing the
   * header to a fresh time.
   */
  it('rejects a signature older than the tolerance window', () => {
    const stale = new Date((Number(TIMESTAMP) + 6 * 60) * 1000);
    expect(valid({ now: stale })).toBe(false);
  });

  it('rejects a timestamp far in the future', () => {
    const skewed = new Date((Number(TIMESTAMP) - 6 * 60) * 1000);
    expect(valid({ now: skewed })).toBe(false);
  });

  it('accepts inside the tolerance window on both sides', () => {
    expect(valid({ now: new Date((Number(TIMESTAMP) + 4 * 60) * 1000) })).toBe(true);
    expect(valid({ now: new Date((Number(TIMESTAMP) - 4 * 60) * 1000) })).toBe(true);
  });

  it('rejects a non-numeric timestamp', () => {
    expect(valid({ timestamp: 'yesterday' })).toBe(false);
  });

  it('rejects an empty secret rather than verifying against nothing', () => {
    expect(valid({ secret: '' })).toBe(false);
  });

  /**
   * The `whsec_` prefix is a label on the secret, not key material. A verifier that
   * forgot to strip it would hash with the wrong key and reject every genuine request
   * — the failure is total but silent, so it is pinned here.
   */
  it('treats the whsec_ prefix as a label, not part of the key', () => {
    const bare = SECRET.replace(/^whsec_/, '');
    expect(valid({ secret: bare })).toBe(true);
  });
});
