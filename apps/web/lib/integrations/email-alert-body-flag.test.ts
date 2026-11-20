import { afterEach, describe, expect, it, vi } from 'vitest';
import { EMAIL_ALERT_BODY_ENABLED_ENV, emailAlertBodyEnabled } from './email-alert-body-flag';

/**
 * VIL-433 · default-off. `vercel env add` from a piped echo stores a trailing newline,
 * which must stay off.
 */

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('emailAlertBodyEnabled', () => {
  it('is on for exactly the literal "true"', () => {
    vi.stubEnv(EMAIL_ALERT_BODY_ENABLED_ENV, 'true');
    expect(emailAlertBodyEnabled()).toBe(true);
  });

  it('fails closed on the trailing newline a piped echo stores', () => {
    vi.stubEnv(EMAIL_ALERT_BODY_ENABLED_ENV, 'true\n');
    expect(emailAlertBodyEnabled()).toBe(false);
  });

  it('fails closed on every other truthy-looking spelling', () => {
    for (const value of ['TRUE', 'True', '1', 'yes', ' true', 'true ']) {
      vi.stubEnv(EMAIL_ALERT_BODY_ENABLED_ENV, value);
      expect(emailAlertBodyEnabled(), value).toBe(false);
    }
  });

  it('is off when unset', () => {
    vi.stubEnv(EMAIL_ALERT_BODY_ENABLED_ENV, '');
    expect(emailAlertBodyEnabled()).toBe(false);
  });
});
