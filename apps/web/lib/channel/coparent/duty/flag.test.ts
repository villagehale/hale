import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  COPARENT_DUTY_ASKS_ALLOWLIST_ENV,
  COPARENT_DUTY_ASKS_ENABLED_ENV,
  coparentDutyAsksActive,
  coparentDutyAsksArmed,
  coparentDutyAsksEnabled,
} from './flag';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('coparent duty asks flag', () => {
  it('is off unless the value is exactly true', () => {
    vi.stubEnv(COPARENT_DUTY_ASKS_ENABLED_ENV, '');
    expect(coparentDutyAsksEnabled()).toBe(false);
    expect(coparentDutyAsksArmed()).toBe(false);
    vi.stubEnv(COPARENT_DUTY_ASKS_ENABLED_ENV, 'true\n');
    expect(coparentDutyAsksEnabled()).toBe(false);
    vi.stubEnv(COPARENT_DUTY_ASKS_ENABLED_ENV, 'TRUE');
    expect(coparentDutyAsksEnabled()).toBe(false);
    vi.stubEnv(COPARENT_DUTY_ASKS_ENABLED_ENV, 'true');
    expect(coparentDutyAsksEnabled()).toBe(true);
    expect(coparentDutyAsksActive('fam-1')).toBe(true);
  });

  it('allowlists families while the global flag is off', () => {
    vi.stubEnv(COPARENT_DUTY_ASKS_ENABLED_ENV, '');
    vi.stubEnv(COPARENT_DUTY_ASKS_ALLOWLIST_ENV, ' fam-a , fam-b ,, ');
    expect(coparentDutyAsksEnabled()).toBe(false);
    expect(coparentDutyAsksArmed()).toBe(true);
    expect(coparentDutyAsksActive('fam-a')).toBe(true);
    expect(coparentDutyAsksActive('fam-c')).toBe(false);
  });
});
