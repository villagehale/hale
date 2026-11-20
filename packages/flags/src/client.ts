import { PostHog } from 'posthog-node';
import { POSTHOG_FEATURE_FLAGS_KEY_ENV } from './catalog.js';

/**
 * Local-evaluation PostHog client for launch flags.
 *
 * Product events (`productClient`) and LLM tracing (`projectClient`) stay in
 * apps/web and apps/worker — one-factory tests pin `new PostHog(` there. This
 * client is the third: it is the only one that takes a personal / feature-flags
 * secure API key, so getFeatureFlag can run against the in-process poller
 * without a per-message round trip.
 *
 * Host helper is shared so events and flags hit the same region.
 */

export const DEFAULT_POSTHOG_HOST = 'https://us.i.posthog.com';

export function posthogHost(env: Record<string, string | undefined> = process.env): string {
  return env.POSTHOG_HOST || env.NEXT_PUBLIC_POSTHOG_HOST || DEFAULT_POSTHOG_HOST;
}

/** Project API key the node SDK constructor needs (not the personal key). */
export function posthogProjectKey(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const product = env.NEXT_PUBLIC_POSTHOG_KEY;
  if (product) return product;
  return env.POSTHOG_PROJECT_API_KEY;
}

type Poller = {
  isLocalEvaluationReady?: () => boolean;
  featureFlagsByKey?: Record<
    string,
    {
      key: string;
      active: boolean;
      deleted?: boolean;
      ensure_experience_continuity?: boolean;
      filters?: {
        aggregation_group_type_index?: number;
        groups?: Array<{
          properties?: Array<unknown>;
          rollout_percentage?: number;
          variant?: string;
        }>;
        multivariate?: { variants: Array<{ key: string; rollout_percentage: number }> };
      };
    }
  >;
  groupTypeMapping?: Record<string, string>;
};

let cached: PostHog | null | undefined;

export function flagsClient(env: Record<string, string | undefined> = process.env): PostHog | null {
  if (cached !== undefined) return cached;
  const projectKey = posthogProjectKey(env);
  const personalKey = env[POSTHOG_FEATURE_FLAGS_KEY_ENV];
  if (!projectKey || !personalKey) {
    cached = null;
    return null;
  }
  cached = new PostHog(projectKey, {
    host: posthogHost(env),
    personalApiKey: personalKey,
    featureFlagsPollingInterval: 30_000,
    requestTimeout: 4_000,
    fetchRetryCount: 0,
    privacyMode: true,
    disableGeoip: true,
    flushAt: 1,
    flushInterval: 0,
    // Never fall through to a remote /flags call on the request path.
    strictLocalEvaluation: true,
  });
  return cached;
}

function pollerOf(client: PostHog): Poller | undefined {
  return (client as unknown as { featureFlagsPoller?: Poller }).featureFlagsPoller;
}

/** Local poller, or undefined when flags have not loaded (or the client is absent). */
export function flagsPoller(
  env: Record<string, string | undefined> = process.env,
): Poller | undefined {
  const client = flagsClient(env);
  if (!client) return undefined;
  const poller = pollerOf(client);
  if (!poller?.featureFlagsByKey) return undefined;
  return poller;
}

export function resetFlagsClientForTests(): void {
  cached = undefined;
}
