import { posthogWebEnabled } from './flags';

type Env = Record<string, string | undefined>;

/**
 * Direct /pricing checkout analytics.
 *
 * `FUNNEL_ATTRIBUTION_ENABLED` is the shared switch, and production sets it on
 * hale-web. The marketing site does not have that variable, so a checkout on
 * villagehale.com never reached PostHog. `NEXT_PUBLIC_POSTHOG_WEB_ENABLED` is
 * the switch that already lights this site's pageviews. Checkout emits when
 * either one is exactly `true`.
 */
export function siteCheckoutAnalyticsEnabled(env: Env = process.env): boolean {
  if (env.FUNNEL_ATTRIBUTION_ENABLED === 'true') return true;
  return posthogWebEnabled(env);
}
