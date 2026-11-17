import { setFlagEvaluatorForTests } from '@hale/flags';
import { afterEach, describe, expect, it } from 'vitest';
import { planCityLoginOwnerEnabled } from './credentials/flag';
import { registrationPlanAtOpenEnabled } from './plan/flag';
import { signupHelpSlotReleaseEnabled } from './signup-help-season';

afterEach(() => {
  setFlagEvaluatorForTests(null);
});

describe('VIL-704 flags', () => {
  it('turn on only for exact true, and a PostHog yes does not', () => {
    setFlagEvaluatorForTests(() => true);
    const posthog = { POSTHOG_FLAGS_ENABLED: 'true', POSTHOG_ID_SALT: 'salt' };
    const readers = [
      [registrationPlanAtOpenEnabled, 'REGISTRATION_PLAN_AT_OPEN_ENABLED'],
      [planCityLoginOwnerEnabled, 'PLAN_CITY_LOGIN_OWNER_ENABLED'],
      [signupHelpSlotReleaseEnabled, 'SIGNUP_HELP_SLOT_RELEASE_ENABLED'],
    ] as const;
    for (const [read, name] of readers) {
      expect(read({ ...posthog }), name).toBe(false);
      for (const value of ['true\n', 'TRUE', 'on', '1', '']) {
        expect(read({ ...posthog, [name]: value }), `${name}=${JSON.stringify(value)}`).toBe(false);
      }
      expect(read({ ...posthog, [name]: 'true' }), name).toBe(true);
    }
    setFlagEvaluatorForTests(() => false);
    expect(
      registrationPlanAtOpenEnabled({
        ...posthog,
        REGISTRATION_PLAN_AT_OPEN_ENABLED: 'true',
      }),
    ).toBe(true);
  });
});
