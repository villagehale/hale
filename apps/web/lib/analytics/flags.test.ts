import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  POSTHOG_REPLAY_ENABLED_ENV,
  POSTHOG_WEB_ENABLED_ENV,
  posthogReplayEnabled,
  posthogWebEnabled,
} from './flags';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('PostHog web/replay flags', () => {
  it('are on only for exactly true — no trim, no TRUE, no 1', () => {
    expect(posthogWebEnabled({ [POSTHOG_WEB_ENABLED_ENV]: 'true' })).toBe(true);
    expect(posthogReplayEnabled({ [POSTHOG_REPLAY_ENABLED_ENV]: 'true' })).toBe(true);
    for (const value of ['', 'TRUE', 'True', '1', 'on', ' true', 'true ', 'true\n', undefined]) {
      expect(posthogWebEnabled({ [POSTHOG_WEB_ENABLED_ENV]: value }), JSON.stringify(value)).toBe(
        false,
      );
      expect(
        posthogReplayEnabled({ [POSTHOG_REPLAY_ENABLED_ENV]: value }),
        JSON.stringify(value),
      ).toBe(false);
    }
  });

  it('stay independent: lighting web does not light replay', () => {
    expect(
      posthogWebEnabled({
        [POSTHOG_WEB_ENABLED_ENV]: 'true',
        [POSTHOG_REPLAY_ENABLED_ENV]: undefined,
      }),
    ).toBe(true);
    expect(
      posthogReplayEnabled({
        [POSTHOG_WEB_ENABLED_ENV]: 'true',
        [POSTHOG_REPLAY_ENABLED_ENV]: undefined,
      }),
    ).toBe(false);
  });
});
