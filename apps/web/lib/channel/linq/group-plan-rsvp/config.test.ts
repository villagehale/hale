import { afterEach, describe, expect, it, vi } from 'vitest';
import { linqGroupPlanRsvpEnabled, linqGroupPollsEnabled } from '../config';

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

describe('LINQ_GROUP_POLLS_ENABLED', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults off and is on only when exactly true', () => {
    vi.stubEnv('LINQ_GROUP_POLLS_ENABLED', '');
    expect(linqGroupPollsEnabled()).toBe(false);
    vi.stubEnv('LINQ_GROUP_POLLS_ENABLED', 'on');
    expect(linqGroupPollsEnabled()).toBe(false);
    vi.stubEnv('LINQ_GROUP_POLLS_ENABLED', 'true');
    expect(linqGroupPollsEnabled()).toBe(true);
    vi.stubEnv('LINQ_GROUP_PLAN_RSVP_ENABLED', 'true');
    vi.stubEnv('LINQ_GROUP_POLLS_ENABLED', 'false');
    expect(linqGroupPollsEnabled()).toBe(false);
    vi.unstubAllEnvs();
    expect(linqGroupPollsEnabled()).toBe(false);
  });
});
