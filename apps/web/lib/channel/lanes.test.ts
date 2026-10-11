import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TRAVEL_BRIEF_ENABLED_ENV } from '../travel/flag';
import { LANE_ENV, type ProactiveLane, laneEnabled } from './lanes';

const LANES: ProactiveLane[] = [
  'calendar_alert',
  'parent_calendar_mirror',
  'email_alert',
  'travel_brief',
  'registration_ladder',
];

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('laneEnabled', () => {
  it('reads each lane from its own variable', () => {
    expect(LANE_ENV).toEqual({
      calendar_alert: 'CALENDAR_ALERT_ENABLED',
      parent_calendar_mirror: 'PARENT_CALENDAR_MIRROR_ENABLED',
      email_alert: 'EMAIL_ALERT_ENABLED',
      travel_brief: 'TRAVEL_BRIEF_ENABLED',
      registration_ladder: 'REGISTRATION_LADDER_ENABLED',
    });
  });

  it('the travel brief lane reads the travel flag module’s own variable name', () => {
    expect(LANE_ENV.travel_brief).toBe(TRAVEL_BRIEF_ENABLED_ENV);
  });

  it.each(LANES)('%s is on for exactly true', (lane) => {
    vi.stubEnv(LANE_ENV[lane], 'true');
    expect(laneEnabled(lane)).toBe(true);
  });

  it.each(LANES)('%s fails closed on surrounding whitespace and a trailing newline', (lane) => {
    for (const value of [' true ', ' true', 'true ', 'true\n']) {
      vi.stubEnv(LANE_ENV[lane], value);
      expect(laneEnabled(lane), JSON.stringify(value)).toBe(false);
    }
  });

  it.each(LANES)('%s is off when unset, empty, or any other spelling', (lane) => {
    vi.stubEnv(LANE_ENV[lane], undefined);
    expect(laneEnabled(lane)).toBe(false);
    for (const value of ['', 'TRUE', 'True', '1', 'on', 'yes', 'false']) {
      vi.stubEnv(LANE_ENV[lane], value);
      expect(laneEnabled(lane)).toBe(false);
    }
  });

  it('turning one lane on leaves the others off', () => {
    vi.stubEnv(LANE_ENV.calendar_alert, 'true');
    vi.stubEnv(LANE_ENV.parent_calendar_mirror, undefined);
    vi.stubEnv(LANE_ENV.email_alert, undefined);
    vi.stubEnv(LANE_ENV.travel_brief, undefined);
    vi.stubEnv(LANE_ENV.registration_ladder, undefined);
    expect(LANES.map(laneEnabled)).toEqual([true, false, false, false, false]);
  });
});

describe('the rollout checklist', () => {
  const checklist = readFileSync(
    join(__dirname, '../../../../docs/flag-rollout-checklist.md'),
    'utf8',
  );

  it('has a row for a flag it is known to list (positive control)', () => {
    expect(checklist).toMatch(/^\| `LOOP_SEND_ENABLED` \|/m);
  });

  it.each(LANES)('has a row for the %s lane variable', (lane) => {
    expect(checklist).toMatch(new RegExp(`^\\| \`${LANE_ENV[lane]}\` \\|`, 'm'));
  });
});
