import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { LINQ_SIGNATURE_TOLERANCE_SECONDS, verifyLinqWebhookSignature } from './signature';

/**
 * Standard Webhooks, computed here from Linq's documented steps — not by calling
 * a helper inside the module under test.
 * https://docs.linqapp.com/guides/webhooks/
 */

const KEY_BYTES = Buffer.alloc(32, 9);
const SECRET = `whsec_${KEY_BYTES.toString('base64')}`;
const NOW = new Date('2026-09-23T12:00:00.000Z');
const TS = String(Math.floor(NOW.getTime() / 1000));
const BODY = '{"event_type":"message.received"}';
const ID = 'msg_evt_fixture';

function sign(id: string, timestamp: string, body: string, key: Buffer = KEY_BYTES): string {
  const mac = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');
  return `v1,${mac}`;
}

function verify(overrides: Partial<Parameters<typeof verifyLinqWebhookSignature>[0]> = {}) {
  return verifyLinqWebhookSignature({
    secret: SECRET,
    rawBody: BODY,
    webhookId: ID,
    timestamp: TS,
    signature: sign(ID, TS, BODY),
    now: NOW,
    ...overrides,
  });
}

describe('verifyLinqWebhookSignature', () => {
  it('accepts a signature over the raw body with the whsec_ key', () => {
    expect(verify()).toBe(true);
  });

  it('accepts the valid token when the header carries more than one', () => {
    expect(verify({ signature: `v0,aaaa ${sign(ID, TS, BODY)}` })).toBe(true);
  });

  it('rejects a body that was re-serialized, a wrong secret, and a missing header', () => {
    expect(verify({ rawBody: `${BODY} ` })).toBe(false);
    const other = Buffer.alloc(32, 3);
    expect(verify({ signature: sign(ID, TS, BODY, other) })).toBe(false);
    expect(verify({ signature: null })).toBe(false);
    expect(verify({ webhookId: null })).toBe(false);
  });

  it('rejects a timestamp outside the five-minute replay window', () => {
    const stale = String(Math.floor(NOW.getTime() / 1000) - LINQ_SIGNATURE_TOLERANCE_SECONDS - 1);
    expect(verify({ timestamp: stale, signature: sign(ID, stale, BODY) })).toBe(false);
  });

  it('does not throw when the secret is not base64', () => {
    expect(verify({ secret: 'whsec_***' })).toBe(false);
  });
});
