import { afterEach, describe, expect, it, vi } from 'vitest';
import { REGISTRATION_ASSISTED_RUN_ENABLED_ENV } from './flag';
import { PLAN_ASSISTED_HOSTS, PLAN_AUTO_HOSTS, planModeFor } from './towns';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('plan towns', () => {
  it('runs a listed PerfectMind host end to end, whatever its case or trailing dot', () => {
    const host = PLAN_AUTO_HOSTS[0] as string;
    expect(planModeFor(`${host.toUpperCase()}.`)).toBe('auto');
  });

  it('prepares an ActiveNet host for the parent to submit only while the assisted switch is on', () => {
    expect(PLAN_ASSISTED_HOSTS).toEqual([
      'anc.ca.apm.activecommunities.com',
      'apm.activecommunities.com',
    ]);
    vi.stubEnv(REGISTRATION_ASSISTED_RUN_ENABLED_ENV, 'true');
    expect(planModeFor('ANC.CA.APM.ACTIVECOMMUNITIES.COM.')).toBe('assisted');
    expect(planModeFor('apm.activecommunities.com')).toBe('assisted');
    expect(planModeFor(PLAN_AUTO_HOSTS[0] as string)).toBe('auto');
    expect(planModeFor('register.example-rec.test')).toBe('parent');

    vi.stubEnv(REGISTRATION_ASSISTED_RUN_ENABLED_ENV, 'true\n');
    expect(planModeFor('anc.ca.apm.activecommunities.com')).toBe('parent');
    vi.stubEnv(REGISTRATION_ASSISTED_RUN_ENABLED_ENV, '');
    expect(planModeFor('anc.ca.apm.activecommunities.com')).toBe('parent');
  });

  it('never reads a look-alike host as ActiveNet', () => {
    vi.stubEnv(REGISTRATION_ASSISTED_RUN_ENABLED_ENV, 'true');
    expect(planModeFor('anc.ca.apm.activecommunities.com.evil.test')).toBe('parent');
    expect(planModeFor('evil-apm.activecommunities.com')).toBe('parent');
  });
});
