import { afterEach, describe, expect, it } from 'vitest';
import {
  TEAM_SCHEDULE_CHANGES_ALLOWLIST_ENV,
  TEAM_SCHEDULE_CHANGES_ENABLED_ENV,
  teamScheduleChangesActive,
  teamScheduleChangesArmed,
  teamScheduleChangesEnabled,
} from './flag';

const FAMILY = '11111111-1111-4111-8111-111111111111';

afterEach(() => {
  delete process.env[TEAM_SCHEDULE_CHANGES_ENABLED_ENV];
  delete process.env[TEAM_SCHEDULE_CHANGES_ALLOWLIST_ENV];
});

describe('teamScheduleChangesEnabled', () => {
  it('is off unless the value is exactly true', () => {
    expect(teamScheduleChangesEnabled()).toBe(false);
    process.env[TEAM_SCHEDULE_CHANGES_ENABLED_ENV] = 'true\n';
    expect(teamScheduleChangesEnabled()).toBe(false);
    process.env[TEAM_SCHEDULE_CHANGES_ENABLED_ENV] = 'TRUE';
    expect(teamScheduleChangesEnabled()).toBe(false);
    process.env[TEAM_SCHEDULE_CHANGES_ENABLED_ENV] = 'true';
    expect(teamScheduleChangesEnabled()).toBe(true);
  });
});

describe('teamScheduleChangesActive', () => {
  it('lists a family while the global flag is still off', () => {
    process.env[TEAM_SCHEDULE_CHANGES_ALLOWLIST_ENV] = ` ${FAMILY}, `;
    expect(teamScheduleChangesArmed()).toBe(true);
    expect(teamScheduleChangesActive(FAMILY)).toBe(true);
    expect(teamScheduleChangesActive('00000000-0000-4000-8000-000000000000')).toBe(false);
  });

  it('opens every family when the global flag is on', () => {
    process.env[TEAM_SCHEDULE_CHANGES_ENABLED_ENV] = 'true';
    expect(teamScheduleChangesActive('00000000-0000-4000-8000-000000000000')).toBe(true);
  });
});
