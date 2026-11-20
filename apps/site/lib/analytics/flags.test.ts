import { describe, expect, it } from 'vitest';
import {
  POSTHOG_REPLAY_ENABLED_ENV,
  POSTHOG_WEB_ENABLED_ENV,
  posthogReplayEnabled,
  posthogWebEnabled,
} from './flags';

describe('PostHog web/replay flags (marketing site)', () => {
  it('share the portal names and the exact-true parser', () => {
    expect(POSTHOG_WEB_ENABLED_ENV).toBe('NEXT_PUBLIC_POSTHOG_WEB_ENABLED');
    expect(POSTHOG_REPLAY_ENABLED_ENV).toBe('NEXT_PUBLIC_POSTHOG_REPLAY_ENABLED');
    expect(posthogWebEnabled({ [POSTHOG_WEB_ENABLED_ENV]: 'true' })).toBe(true);
    expect(posthogWebEnabled({ [POSTHOG_WEB_ENABLED_ENV]: 'true\n' })).toBe(false);
    expect(posthogReplayEnabled({ [POSTHOG_REPLAY_ENABLED_ENV]: 'TRUE' })).toBe(false);
  });
});
