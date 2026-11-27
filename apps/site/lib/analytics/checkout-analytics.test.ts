import { describe, expect, it } from 'vitest';
import { siteCheckoutAnalyticsEnabled } from './checkout-analytics';

describe('siteCheckoutAnalyticsEnabled', () => {
  it('is on for the funnel flag or the site web flag, and off otherwise', () => {
    expect(siteCheckoutAnalyticsEnabled({})).toBe(false);
    expect(siteCheckoutAnalyticsEnabled({ FUNNEL_ATTRIBUTION_ENABLED: 'TRUE' })).toBe(false);
    expect(siteCheckoutAnalyticsEnabled({ NEXT_PUBLIC_POSTHOG_WEB_ENABLED: 'true\n' })).toBe(false);
    expect(siteCheckoutAnalyticsEnabled({ FUNNEL_ATTRIBUTION_ENABLED: 'true' })).toBe(true);
    expect(siteCheckoutAnalyticsEnabled({ NEXT_PUBLIC_POSTHOG_WEB_ENABLED: 'true' })).toBe(true);
  });
});
