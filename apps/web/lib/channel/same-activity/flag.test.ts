import { afterEach, describe, expect, it, vi } from 'vitest';
import { SAME_ACTIVITY_MEET_ENABLED_ENV, sameActivityMeetEnabled } from './flag';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('SAME_ACTIVITY_MEET_ENABLED', () => {
  it('is on only for the exact string true', () => {
    vi.stubEnv(SAME_ACTIVITY_MEET_ENABLED_ENV, 'true');
    expect(sameActivityMeetEnabled()).toBe(true);
  });

  it.each(['', 'true\n', 'TRUE', 'True', 'on', '1', 'yes', ' false', 'true '])(
    'stays off for %j',
    (value) => {
      vi.stubEnv(SAME_ACTIVITY_MEET_ENABLED_ENV, value);
      expect(sameActivityMeetEnabled()).toBe(false);
    },
  );

  it('stays off when the variable is unset', () => {
    vi.stubEnv(SAME_ACTIVITY_MEET_ENABLED_ENV, undefined);
    expect(sameActivityMeetEnabled()).toBe(false);
    expect(sameActivityMeetEnabled({})).toBe(false);
  });
});
