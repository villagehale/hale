import { afterEach, describe, expect, it, vi } from 'vitest';
import { SIGNUP_WITH_OK_STARTS_ON, signupWithOkFact, signupWithOkLiveNow } from './with-ok';

describe('signupWithOk', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is not live and still ahead while the authorized-signup flags are off', () => {
    vi.stubEnv('AUTHORIZED_SIGNUP_ENABLED', '');
    vi.stubEnv('BROWSER_USE_SIGNUP_ENABLED', '');
    vi.stubEnv('BROWSER_USE_SIGNUP_PAYMENT_ENABLED', '');
    vi.stubEnv('REGISTRATION_PLAN_RUN_ENABLED', '');
    // 1:00 p.m. America/Toronto on 2026-11-23.
    const fact = signupWithOkFact(new Date('2026-11-23T18:00:00.000Z'));
    expect(fact).toEqual({
      startsOn: SIGNUP_WITH_OK_STARTS_ON,
      liveNow: false,
      startsInFuture: true,
    });
    expect(SIGNUP_WITH_OK_STARTS_ON).toBe('2026-12-01');
  });

  it('stays not live unless authorized signup is on and the plan-run lane is true', () => {
    expect(signupWithOkLiveNow({ AUTHORIZED_SIGNUP_ENABLED: 'on' })).toBe(false);
    expect(signupWithOkLiveNow({ AUTHORIZED_SIGNUP_ENABLED: 'true' })).toBe(false);
    expect(signupWithOkLiveNow({ AUTHORIZED_SIGNUP_ENABLED: 'ON' })).toBe(false);
    expect(signupWithOkLiveNow({ REGISTRATION_PLAN_RUN_ENABLED: 'true' })).toBe(false);
    expect(
      signupWithOkLiveNow({
        AUTHORIZED_SIGNUP_ENABLED: 'on',
        REGISTRATION_PLAN_RUN_ENABLED: 'TRUE',
      }),
    ).toBe(false);
    expect(
      signupWithOkLiveNow({
        AUTHORIZED_SIGNUP_ENABLED: 'on',
        BROWSER_USE_SIGNUP_ENABLED: 'true',
        BROWSER_USE_SIGNUP_PAYMENT_ENABLED: 'true',
      }),
    ).toBe(false);
    expect(
      signupWithOkLiveNow({
        AUTHORIZED_SIGNUP_ENABLED: 'on',
        REGISTRATION_PLAN_RUN_ENABLED: 'true',
      }),
    ).toBe(true);
  });

  it('stops calling the start a future date on the Toronto calendar of Dec 1', () => {
    // 11:59 p.m. America/Toronto on Nov 30 is still ahead.
    expect(signupWithOkFact(new Date('2026-12-01T04:59:00.000Z')).startsInFuture).toBe(true);
    // Midnight America/Toronto on Dec 1 is not still ahead.
    expect(signupWithOkFact(new Date('2026-12-01T05:00:00.000Z')).startsInFuture).toBe(false);
    const live = signupWithOkFact(new Date('2026-12-02T15:00:00.000Z'), {
      AUTHORIZED_SIGNUP_ENABLED: 'on',
      REGISTRATION_PLAN_RUN_ENABLED: 'true',
    });
    expect(live).toEqual({
      startsOn: '2026-12-01',
      liveNow: true,
      startsInFuture: false,
    });
  });
});
