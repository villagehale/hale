import { afterEach, describe, expect, it, vi } from 'vitest';
import { errorTrackingEnabled, posthogOpsAlertsEnabled, productEventsEnabled } from './flags';

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
