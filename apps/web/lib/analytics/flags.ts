/**
 * Dark-launch gates for browser PostHog (villagehale.com / the portal).
 *
 * Exact `true`, no trim — the same parser as the lane flags. Unset, `TRUE`,
 * `true\n`, and `1` all stay off. Turned on in Prod after merge, then a redeploy.
 *
 * Server-side SMS/agent events still key off NEXT_PUBLIC_POSTHOG_KEY alone;
 * these two flags only arm posthog-js (pageviews, autocapture, replay, surveys).
 */

export const POSTHOG_WEB_ENABLED_ENV = 'NEXT_PUBLIC_POSTHOG_WEB_ENABLED';
export const POSTHOG_REPLAY_ENABLED_ENV = 'NEXT_PUBLIC_POSTHOG_REPLAY_ENABLED';

export function posthogWebEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[POSTHOG_WEB_ENABLED_ENV] === 'true';
}

export function posthogReplayEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[POSTHOG_REPLAY_ENABLED_ENV] === 'true';
}
