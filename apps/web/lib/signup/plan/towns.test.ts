import { describe, expect, it } from 'vitest';
import { PLAN_ASSISTED_HOSTS, PLAN_AUTO_HOSTS, planModeFor, providerHint } from './towns';

describe('plan towns', () => {
  it('runs any public host through the generic auto path, including an unseen fixture', () => {
    expect(planModeFor('register.example-rec.test')).toBe('auto');
    expect(planModeFor('REC.FIXTURE-UNSEEN.TEST.')).toBe('auto');
    expect(planModeFor('cityofmarkham.perfectmind.com')).toBe('auto');
    expect(planModeFor('anc.ca.apm.activecommunities.com')).toBe('auto');
    expect(planModeFor('gym.jackrabbitclass.com')).toBe('auto');
    expect(planModeFor('haltonhills.perfectmind.com')).toBe('auto');
    expect(planModeFor('www.haltonhills.ca')).toBe('auto');
    expect(planModeFor('haltonhills.perfectmind.com', ['cityofmarkham.perfectmind.com'])).toBe(
      'auto',
    );
    expect(PLAN_AUTO_HOSTS).toEqual([]);
    expect(PLAN_ASSISTED_HOSTS).toEqual([]);
  });

  it('is parent only when there is no host at all', () => {
    expect(planModeFor('')).toBe('parent');
    expect(planModeFor('   ')).toBe('parent');
  });

  it('may hint a known platform without gating on it', () => {
    expect(providerHint('haltonhills.perfectmind.com')).toBe('perfectmind');
    expect(providerHint('anc.ca.apm.activecommunities.com')).toBe('activenet');
    expect(providerHint('rec.fixture-unseen.test')).toBeNull();
  });
});
