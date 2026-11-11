/**
 * Launch flags for server-side PostHog. All default off (unset ≠ true). Trim, then
 * the exact string `true`. Prod turns them on after merge.
 *
 * Keep identical to apps/web/lib/analytics/flags.ts — the worker cannot import from
 * apps/web (web depends on the worker, not the reverse).
 */

type Env = Record<string, string | undefined>;

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
