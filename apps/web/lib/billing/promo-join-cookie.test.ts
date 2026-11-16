import { describe, expect, it } from 'vitest';
import { readPromoJoinBinding, signPromoJoinBinding } from './promo-join-cookie.js';

const BINDING = {
  familyId: 'fam-1',
  userId: 'user-1',
  externalAuthId: 'sms:abc',
};

describe('promo join cookie', () => {
  it('is null without AUTH_SECRET', () => {
    expect(signPromoJoinBinding(BINDING, {})).toBeNull();
    expect(readPromoJoinBinding('anything', { AUTH_SECRET: 's' })).toBeNull();
  });

  it('round-trips a binding and rejects a tampered mac', () => {
    const env = { AUTH_SECRET: 'test-secret' };
    const token = signPromoJoinBinding(BINDING, env, { now: 1_000 });
    expect(token).toBeTruthy();
    expect(readPromoJoinBinding(token ?? undefined, env, { now: 1_000 })).toEqual(BINDING);
    expect(readPromoJoinBinding(`${token}x`, env, { now: 1_000 })).toBeNull();
  });

  it('expires', () => {
    const env = { AUTH_SECRET: 'test-secret' };
    const token = signPromoJoinBinding(BINDING, env, { now: 1_000, ttlSeconds: 10 });
    expect(readPromoJoinBinding(token ?? undefined, env, { now: 12_000 })).toBeNull();
  });
});
