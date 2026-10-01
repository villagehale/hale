import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  COPARENT_DUTY_ASKS_ALLOWLIST_ENV,
  COPARENT_DUTY_ASKS_ENABLED_ENV,
  COPARENT_DUTY_BURDEN_SURFACE_ENABLED_ENV,
  COPARENT_DUTY_LOPSIDED_ENABLED_ENV,
  COPARENT_DUTY_MEMORY_ENABLED_ENV,
  COPARENT_DUTY_SENDS_ALLOWLIST_ENV,
  COPARENT_DUTY_SENDS_ENABLED_ENV,
  coparentDutyAsksActive,
  coparentDutyAsksArmed,
  coparentDutyAsksEnabled,
  coparentDutyBurdenSurfaceEnabled,
  coparentDutyLopsidedEnabled,
  coparentDutyMemoryEnabled,
  coparentDutySendsActive,
  coparentDutySendsArmed,
  coparentDutySendsEnabled,
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

describe('coparent duty sends flag', () => {
  it('is off unless the value is exactly true', () => {
    vi.stubEnv(COPARENT_DUTY_SENDS_ENABLED_ENV, '');
    expect(coparentDutySendsEnabled()).toBe(false);
    expect(coparentDutySendsArmed()).toBe(false);
    vi.stubEnv(COPARENT_DUTY_SENDS_ENABLED_ENV, 'true\n');
    expect(coparentDutySendsEnabled()).toBe(false);
    vi.stubEnv(COPARENT_DUTY_SENDS_ENABLED_ENV, 'TRUE');
    expect(coparentDutySendsEnabled()).toBe(false);
    vi.stubEnv(COPARENT_DUTY_SENDS_ENABLED_ENV, 'true');
    expect(coparentDutySendsEnabled()).toBe(true);
    expect(coparentDutySendsActive('fam-1')).toBe(true);
  });

  it('allowlists families while the global flag is off', () => {
    vi.stubEnv(COPARENT_DUTY_SENDS_ENABLED_ENV, '');
    vi.stubEnv(COPARENT_DUTY_SENDS_ALLOWLIST_ENV, ' fam-a , fam-b ,, ');
    expect(coparentDutySendsEnabled()).toBe(false);
    expect(coparentDutySendsArmed()).toBe(true);
    expect(coparentDutySendsActive('fam-a')).toBe(true);
    expect(coparentDutySendsActive('fam-c')).toBe(false);
  });
});

describe('coparent duty memory flags', () => {
  it('stay off unless the value is exactly true', () => {
    for (const [env, read] of [
      [COPARENT_DUTY_MEMORY_ENABLED_ENV, coparentDutyMemoryEnabled],
      [COPARENT_DUTY_LOPSIDED_ENABLED_ENV, coparentDutyLopsidedEnabled],
      [COPARENT_DUTY_BURDEN_SURFACE_ENABLED_ENV, coparentDutyBurdenSurfaceEnabled],
    ] as const) {
      vi.stubEnv(env, '');
      expect(read()).toBe(false);
      vi.stubEnv(env, 'true\n');
      expect(read()).toBe(false);
      vi.stubEnv(env, 'TRUE');
      expect(read()).toBe(false);
      vi.stubEnv(env, 'true');
      expect(read()).toBe(true);
    }
  });
});
