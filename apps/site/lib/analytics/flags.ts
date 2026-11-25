/**
 * Dark-launch gates for browser PostHog on the marketing site.
 *
 * Exact `true`, no trim. Unset stays off. Same names as apps/web, so one Vercel
 * pair turns both surfaces on after merge.
 */

export const POSTHOG_WEB_ENABLED_ENV = 'NEXT_PUBLIC_POSTHOG_WEB_ENABLED';
export const POSTHOG_REPLAY_ENABLED_ENV = 'NEXT_PUBLIC_POSTHOG_REPLAY_ENABLED';

// Next.js inlines only a literal `process.env.NEXT_PUBLIC_*` into browser code. A read by a
// variable name is undefined there, which kept posthog-js from ever loading (pageviews 0).
// So the default path names each variable literally; an env object is for tests.
export function posthogWebEnabled(env?: Record<string, string | undefined>): boolean {
  const value = env ? env[POSTHOG_WEB_ENABLED_ENV] : process.env.NEXT_PUBLIC_POSTHOG_WEB_ENABLED;
  return value === 'true';
}

export function posthogReplayEnabled(env?: Record<string, string | undefined>): boolean {
  const value = env
    ? env[POSTHOG_REPLAY_ENABLED_ENV]
    : process.env.NEXT_PUBLIC_POSTHOG_REPLAY_ENABLED;
  return value === 'true';
}
