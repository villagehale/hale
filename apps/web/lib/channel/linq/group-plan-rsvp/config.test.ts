import { afterEach, describe, expect, it, vi } from 'vitest';
import { linqGroupPlanRsvpEnabled } from '../config';

describe('LINQ_GROUP_PLAN_RSVP_ENABLED', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is on only when the flag is exactly true after trimming', () => {
    vi.stubEnv('LINQ_GROUP_PLAN_RSVP_ENABLED', 'true');
    expect(linqGroupPlanRsvpEnabled()).toBe(true);
    vi.stubEnv('LINQ_GROUP_PLAN_RSVP_ENABLED', 'true\n');
    expect(linqGroupPlanRsvpEnabled()).toBe(true);
    vi.stubEnv('LINQ_GROUP_PLAN_RSVP_ENABLED', 'on');
    expect(linqGroupPlanRsvpEnabled()).toBe(false);
    vi.stubEnv('LINQ_GROUP_PLAN_RSVP_ENABLED', 'false');
    expect(linqGroupPlanRsvpEnabled()).toBe(false);
    vi.stubEnv('LINQ_GROUP_PLAN_RSVP_ENABLED', '');
    expect(linqGroupPlanRsvpEnabled()).toBe(false);
    vi.unstubAllEnvs();
    expect(linqGroupPlanRsvpEnabled()).toBe(false);
  });
});
