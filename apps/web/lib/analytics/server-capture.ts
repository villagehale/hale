import { type AnalyticsEvent, buildEvent } from './events';

/**
 * Server-side analytics capture for the paths a client hook can't reach — the
 * sign-up server action fires signup_completed here on ACTUAL account creation, not
 * on button-intent, so cancelled/failed attempts aren't counted as conversions.
 *
 * Dependency-free: a single POST to PostHog's public capture endpoint (no
 * posthog-node client, no flush lifecycle to leak in a short-lived server action).
 * It reads the SAME key/host as the client provider and routes every payload through
 * the SAME buildEvent redaction chokepoint, so identifying or non-primitive
 * properties can never leave (rule #1). No-ops cleanly when no key is configured.
 */

export async function captureServerEvent(
  event: AnalyticsEvent,
  distinctId: string,
  properties: Record<string, unknown> = {},
): Promise<void> {
  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  if (!key) {
    return;
  }
  const host = process.env.NEXT_PUBLIC_POSTHOG_HOST ?? 'https://us.i.posthog.com';
  const { event: name, properties: safe } = buildEvent(event, properties);
  await fetch(`${host}/i/v0/e/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: key,
      event: name,
      distinct_id: distinctId,
      properties: safe,
    }),
  });
}
