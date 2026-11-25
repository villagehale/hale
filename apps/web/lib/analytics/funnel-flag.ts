import { isEnabled } from '@hale/flags';

/** FUNNEL_ATTRIBUTION_ENABLED: env-only, exact `true` (packages/flags/src/catalog.ts). */
export function funnelAttributionEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return isEnabled('funnel-attribution', undefined, env);
}
