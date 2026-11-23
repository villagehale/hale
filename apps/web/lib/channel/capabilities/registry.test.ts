import { afterEach, describe, expect, it, vi } from 'vitest';
import { capabilityLit } from './registry';

describe('sign_up is live on the same check as signupWithOk', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('stays dark when only one of the two flags is set', () => {
    vi.stubEnv('AUTHORIZED_SIGNUP_ENABLED', 'on');
    vi.stubEnv('REGISTRATION_PLAN_RUN_ENABLED', '');
    expect(capabilityLit('sign_up', 'fam')).toBe(false);

    vi.stubEnv('AUTHORIZED_SIGNUP_ENABLED', '');
    vi.stubEnv('REGISTRATION_PLAN_RUN_ENABLED', 'true');
    expect(capabilityLit('sign_up', 'fam')).toBe(false);

    vi.stubEnv('AUTHORIZED_SIGNUP_ENABLED', 'on');
    vi.stubEnv('REGISTRATION_PLAN_RUN_ENABLED', 'on');
    expect(capabilityLit('sign_up', 'fam')).toBe(false);
  });

  it('lights only when authorized signup is on and the plan-run lane is true', () => {
    vi.stubEnv('AUTHORIZED_SIGNUP_ENABLED', 'on');
    vi.stubEnv('REGISTRATION_PLAN_RUN_ENABLED', 'true');
    expect(capabilityLit('sign_up', 'fam')).toBe(true);
  });
});
