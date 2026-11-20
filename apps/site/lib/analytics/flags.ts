/**
 * Dark-launch gates for browser PostHog on the marketing site.
 *
 * Exact `true`, no trim. Unset stays off. Same names as apps/web, so one Vercel
 * pair turns both surfaces on after merge.
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
