import { describe, expect, it } from 'vitest';
import { PLAN_AUTO_HOSTS, planModeFor } from './towns';

describe('plan towns', () => {
  it('runs a listed PerfectMind host end to end, whatever its case or trailing dot', () => {
    const host = PLAN_AUTO_HOSTS[0] as string;
    expect(planModeFor(`${host.toUpperCase()}.`)).toBe('auto');
  });

  it('keeps every other host assisted, ActiveNet included', () => {
    expect(planModeFor('anc.ca.apm.activecommunities.com')).toBe('assisted');
    expect(planModeFor('register.example-rec.test')).toBe('assisted');
  });
});
