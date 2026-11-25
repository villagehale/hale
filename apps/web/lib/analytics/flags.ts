/**
 * Launch flags for PostHog. All default off (unset ≠ true).
 *
 * Browser gates (villagehale.com / the portal): exact `true`, no trim — the same
 * parser as the lane flags. Unset, `TRUE`, `true\n`, and `1` all stay off. These
 * two only arm posthog-js (pageviews, autocapture, replay, surveys).
 *
 * Server-side gates: trim, then the exact string `true`. Keep identical to
 * apps/worker/src/analytics/flags.ts — web cannot import worker analytics (the
 * worker PostHog client is a copy for the same reason).
 *
 * Prod turns them on after merge, then a redeploy.
 */

type Env = Record<string, string | undefined>;

export const POSTHOG_WEB_ENABLED_ENV = 'NEXT_PUBLIC_POSTHOG_WEB_ENABLED';
export const POSTHOG_REPLAY_ENABLED_ENV = 'NEXT_PUBLIC_POSTHOG_REPLAY_ENABLED';

// Next.js inlines only a literal `process.env.NEXT_PUBLIC_*` into browser code. A read by a
// variable name is undefined there, so the browser never armed posthog-js. The default
// path names each variable literally; an env object is for tests.
export function posthogWebEnabled(env?: Env): boolean {
  const value = env ? env[POSTHOG_WEB_ENABLED_ENV] : process.env.NEXT_PUBLIC_POSTHOG_WEB_ENABLED;
  return value === 'true';
}

export function posthogReplayEnabled(env?: Env): boolean {
  const value = env
    ? env[POSTHOG_REPLAY_ENABLED_ENV]
    : process.env.NEXT_PUBLIC_POSTHOG_REPLAY_ENABLED;
  return value === 'true';
}

function exactTrue(name: string, env: Env): boolean {
  return env[name]?.trim() === 'true';
}

/** Product events (message_*, task_completed, onboarding_*, group_*, family_signed_up). */
export function productEventsEnabled(env: Env = process.env): boolean {
  return exactTrue('POSTHOG_PRODUCT_EVENTS_ENABLED', env);
}

/** $exception plus send_failed / message_unanswered / turn_failed / registration_run_failed. */
export function errorTrackingEnabled(env: Env = process.env): boolean {
  return exactTrue('POSTHOG_ERROR_TRACKING_ENABLED', env);
}

/**
 * When true, PostHog insight alerts are the paging path for send/turn/registration
 * failures. The daily #ops Slack post still runs until Barton retires it.
 */
export function posthogOpsAlertsEnabled(env: Env = process.env): boolean {
  return exactTrue('POSTHOG_OPS_ALERTS_ENABLED', env);
}
