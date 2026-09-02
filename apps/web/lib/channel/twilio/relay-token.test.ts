import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  RELAY_TOKEN_TTL_SECONDS,
  mintRelayToken,
  verifyRelayToken,
} from './relay-token';

const KEY_A = Buffer.alloc(32, 3).toString('base64');
const KEY_B = Buffer.alloc(32, 4).toString('base64');

const CALL_SID = 'CA00000000000000000000000000000001';
const OTHER_CALL_SID = 'CA00000000000000000000000000000002';
const TICKET = {
  callSid: CALL_SID,
  familyId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
  parentUserId: '9c858901-8a57-4791-81fe-4c455b099bc9',
};
const MINTED_AT = new Date('2026-08-19T14:00:00.000Z');
/** Inside the window: a caller picks up within a second or two of the TwiML. */
const CONNECTED_AT = new Date('2026-08-19T14:00:03.000Z');

describe('voice relay ticket', () => {
  const prev = process.env.APP_ENCRYPTION_KEY;
  beforeEach(() => {
    process.env.APP_ENCRYPTION_KEY = KEY_A;
  });
  afterEach(() => {
    process.env.APP_ENCRYPTION_KEY = prev;
  });

  it('round-trips the identity the TwiML resolved — the socket never has to ask who is calling', () => {
    const token = mintRelayToken(TICKET, MINTED_AT);
    expect(verifyRelayToken(token, CALL_SID, CONNECTED_AT)).toEqual({
      ok: true,
      ticket: TICKET,
    });
  });

  it('binds the family: a tampered family id is refused, the same token untouched is not', () => {
    const token = mintRelayToken(TICKET, MINTED_AT);
    const forged = token.replace(TICKET.familyId, '00000000-0000-4000-8000-000000000000');

    expect(forged).not.toBe(token);
    expect(verifyRelayToken(forged, CALL_SID, CONNECTED_AT)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
    // Positive control: the refusal above is the tamper, not the whole path failing.
    expect(verifyRelayToken(token, CALL_SID, CONNECTED_AT).ok).toBe(true);
  });

  it('binds the call: a ticket for one call cannot open a socket for another', () => {
    const token = mintRelayToken(TICKET, MINTED_AT);
    expect(verifyRelayToken(token, OTHER_CALL_SID, CONNECTED_AT)).toEqual({
      ok: false,
      reason: 'call_mismatch',
    });
  });

  it('expires: a ticket is dead one second past its window', () => {
    const token = mintRelayToken(TICKET, MINTED_AT);
    const justInside = new Date(MINTED_AT.getTime() + RELAY_TOKEN_TTL_SECONDS * 1000);
    const justOutside = new Date(justInside.getTime() + 1000);

    expect(verifyRelayToken(token, CALL_SID, justInside).ok).toBe(true);
    expect(verifyRelayToken(token, CALL_SID, justOutside)).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('mints a window no longer than the policy — the lifetime is in the signed payload', () => {
    const token = mintRelayToken(TICKET, MINTED_AT);
    const exp = Number(token.split('.').at(-2));
    expect(exp - Math.floor(MINTED_AT.getTime() / 1000)).toBe(RELAY_TOKEN_TTL_SECONDS);
  });

  it('is keyed: a ticket minted under one deployment key is refused under another', () => {
    const token = mintRelayToken(TICKET, MINTED_AT);
    process.env.APP_ENCRYPTION_KEY = KEY_B;
    expect(verifyRelayToken(token, CALL_SID, CONNECTED_AT)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('refuses a missing or shapeless token without reaching the key', () => {
    expect(verifyRelayToken(null, CALL_SID, CONNECTED_AT)).toEqual({
      ok: false,
      reason: 'malformed',
    });
    expect(verifyRelayToken('', CALL_SID, CONNECTED_AT)).toEqual({
      ok: false,
      reason: 'malformed',
    });
    expect(verifyRelayToken('not-a-ticket', CALL_SID, CONNECTED_AT)).toEqual({
      ok: false,
      reason: 'malformed',
    });
    expect(
      verifyRelayToken(`${CALL_SID}.a.b.notanumber.deadbeef`, CALL_SID, CONNECTED_AT),
    ).toEqual({ ok: false, reason: 'malformed' });
  });

  it('carries no phone number — the URL it rides in is logged by a third party', () => {
    const token = mintRelayToken(TICKET, MINTED_AT);
    expect(token).not.toContain('+1');
    expect(encodeURIComponent(token)).toBe(token);
  });
});
