import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EMAIL_ALERT_HOLD_DEBT_ENABLED_ENV,
  emailAlertHoldDebtEnabled,
} from './email-alert-hold-flag';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('EMAIL_ALERT_HOLD_DEBT_ENABLED', () => {
  it('is on only for the exact string true', () => {
    vi.stubEnv(EMAIL_ALERT_HOLD_DEBT_ENABLED_ENV, 'true');
    expect(emailAlertHoldDebtEnabled()).toBe(true);
  });

  it.each(['', 'true\n', 'TRUE', 'True', 'on', '1', 'yes', ' false', 'true '])(
    'stays off for %j',
    (value) => {
      vi.stubEnv(EMAIL_ALERT_HOLD_DEBT_ENABLED_ENV, value);
      expect(emailAlertHoldDebtEnabled()).toBe(false);
    },
  );

  it('stays off when the variable is unset', () => {
    vi.stubEnv(EMAIL_ALERT_HOLD_DEBT_ENABLED_ENV, undefined);
    expect(emailAlertHoldDebtEnabled()).toBe(false);
    expect(emailAlertHoldDebtEnabled({})).toBe(false);
  });
});
