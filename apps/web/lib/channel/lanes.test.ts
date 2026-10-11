import { afterEach, describe, expect, it, vi } from 'vitest';
import { LANE_ENV, type ProactiveLane, laneEnabled } from './lanes';

const LANES: ProactiveLane[] = ['calendar_alert', 'parent_calendar_mirror', 'email_alert'];

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('laneEnabled', () => {
  it('reads each lane from its own variable', () => {
    expect(LANE_ENV).toEqual({
      calendar_alert: 'CALENDAR_ALERT_ENABLED',
      parent_calendar_mirror: 'PARENT_CALENDAR_MIRROR_ENABLED',
      email_alert: 'EMAIL_ALERT_ENABLED',
    });
  });

  it.each(LANES)('%s is on for exactly true, surrounding whitespace trimmed', (lane) => {
    vi.stubEnv(LANE_ENV[lane], 'true');
    expect(laneEnabled(lane)).toBe(true);
    vi.stubEnv(LANE_ENV[lane], ' true ');
    expect(laneEnabled(lane)).toBe(true);
  });

  it.each(LANES)('%s is off when unset, empty, or any other spelling', (lane) => {
    vi.stubEnv(LANE_ENV[lane], undefined);
    expect(laneEnabled(lane)).toBe(false);
    for (const value of ['', 'TRUE', 'True', '1', 'on', 'yes', 'false']) {
      vi.stubEnv(LANE_ENV[lane], value);
      expect(laneEnabled(lane)).toBe(false);
    }
  });

  it('turning one lane on leaves the other two off', () => {
    vi.stubEnv(LANE_ENV.calendar_alert, 'true');
    vi.stubEnv(LANE_ENV.parent_calendar_mirror, undefined);
    vi.stubEnv(LANE_ENV.email_alert, undefined);
    expect(LANES.map(laneEnabled)).toEqual([true, false, false]);
  });
});
