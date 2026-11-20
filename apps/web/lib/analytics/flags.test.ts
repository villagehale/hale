import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  POSTHOG_REPLAY_ENABLED_ENV,
  POSTHOG_WEB_ENABLED_ENV,
  errorTrackingEnabled,
  posthogOpsAlertsEnabled,
  posthogReplayEnabled,
  posthogWebEnabled,
  productEventsEnabled,
} from './flags';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('launch flags default off', () => {
  it('unset, empty, and TRUE-in-the-wrong-case are all off', () => {
    expect(productEventsEnabled({})).toBe(false);
    expect(errorTrackingEnabled({})).toBe(false);
    expect(posthogOpsAlertsEnabled({})).toBe(false);
    expect(productEventsEnabled({ POSTHOG_PRODUCT_EVENTS_ENABLED: '' })).toBe(false);
    expect(productEventsEnabled({ POSTHOG_PRODUCT_EVENTS_ENABLED: 'TRUE' })).toBe(false);
    expect(productEventsEnabled({ POSTHOG_PRODUCT_EVENTS_ENABLED: '1' })).toBe(false);
    expect(errorTrackingEnabled({ POSTHOG_ERROR_TRACKING_ENABLED: 'yes' })).toBe(false);
  });

  it('only the exact trimmed string true turns a flag on', () => {
    expect(productEventsEnabled({ POSTHOG_PRODUCT_EVENTS_ENABLED: 'true' })).toBe(true);
    expect(productEventsEnabled({ POSTHOG_PRODUCT_EVENTS_ENABLED: ' true\n' })).toBe(true);
    expect(errorTrackingEnabled({ POSTHOG_ERROR_TRACKING_ENABLED: 'true' })).toBe(true);
    expect(posthogOpsAlertsEnabled({ POSTHOG_OPS_ALERTS_ENABLED: 'true' })).toBe(true);
  });
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
