import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ConnectState, signConnectState, verifyConnectState } from './connect-state';

const STATE: ConnectState = {
  familyId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  provider: 'gcal',
};

describe('connector connect-state (signed OAuth state)', () => {
  const prev = process.env.AUTH_SECRET;
  beforeEach(() => {
    process.env.AUTH_SECRET = 'test-signing-secret';
  });
  afterEach(() => {
    process.env.AUTH_SECRET = prev;
  });

  it('round-trips the family/user/provider binding', () => {
    expect(verifyConnectState(signConnectState(STATE))).toEqual(STATE);
  });

  it('rejects a tampered payload (attacker cannot swap the bound family)', () => {
    const token = signConnectState(STATE);
    const [body, mac] = token.split('.');
    const forged = Buffer.from(
      JSON.stringify({ ...STATE, familyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', exp: Date.now() + 60000 }),
    ).toString('base64url');
    expect(() => verifyConnectState(`${forged}.${mac}`)).toThrow(/signature/);
    expect(body).toBeTruthy();
  });

  it('rejects an expired state', () => {
    const now = 1_000_000_000_000;
    const token = signConnectState(STATE, { ttlSeconds: 600, now });
    expect(() => verifyConnectState(token, { now: now + 601_000 })).toThrow(/expired/);
    // still valid just before expiry
    expect(verifyConnectState(token, { now: now + 599_000 })).toEqual(STATE);
  });

  it('cannot be verified with a different signing secret', () => {
    const token = signConnectState(STATE);
    process.env.AUTH_SECRET = 'a-different-secret';
    expect(() => verifyConnectState(token)).toThrow(/signature/);
  });

  it('throws when AUTH_SECRET is missing', () => {
    process.env.AUTH_SECRET = '';
    expect(() => signConnectState(STATE)).toThrow(/AUTH_SECRET/);
  });
});
