'use client';

import posthog from 'posthog-js';
import { PostHogProvider as PostHogJsProvider, usePostHog } from 'posthog-js/react';
import { useEffect } from 'react';
import { type AnalyticsEvent, buildEvent } from './events';

const KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY;
const HOST = process.env.NEXT_PUBLIC_POSTHOG_HOST;

/** True only when a key is configured — otherwise the whole layer is a no-op. */
export function analyticsEnabled(): boolean {
  return Boolean(KEY);
}

/**
 * Initialize posthog-js once, privacy-first (hard rule #1):
 *  - autocapture OFF — we only send the hand-picked key-loop events.
 *  - session recording OFF — never replay a parent's screen.
 *  - respect_dnt ON, plus opt-out-by-default capturing honoured by the browser.
 *  - capture_pageview ON — URLs only (our routes carry no PII).
 *  - mask_all_text / mask_all_element_attributes ON as belt-and-suspenders, so
 *    even if a stray autocapture ever fired it could not read input contents.
 *  - persistence is the minimal first-party cookie+localStorage default.
 * Identity is the opaque user id only — set later via `identify`, never email.
 */
function initPostHog(): void {
  if (!KEY || posthog.__loaded) return;
  posthog.init(KEY, {
    api_host: HOST ?? 'https://us.i.posthog.com',
    autocapture: false,
    capture_pageview: true,
    disable_session_recording: true,
    respect_dnt: true,
    mask_all_text: true,
    mask_all_element_attributes: true,
  });
}

/**
 * Wraps the app. When no key is configured it renders children untouched — no
 * init, no network, no errors — so the build ships safely now and starts
 * collecting the moment the key is added.
 */
export function PostHogProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    initPostHog();
  }, []);

  if (!analyticsEnabled()) return <>{children}</>;
  return <PostHogJsProvider client={posthog}>{children}</PostHogJsProvider>;
}

/**
 * Returns a capture function bound to the privacy gate. Every property goes
 * through `buildEvent`, so identifying or non-primitive fields are stripped
 * before they reach PostHog. No-ops cleanly when analytics is disabled.
 */
export function useAnalytics(): (
  event: AnalyticsEvent,
  properties?: Record<string, unknown>,
) => void {
  const client = usePostHog();
  return (event, properties) => {
    if (!client) return;
    const { event: name, properties: safe } = buildEvent(event, properties);
    client.capture(name, safe);
  };
}

/**
 * Identify the current user by their OPAQUE id only (never email/name). No-ops
 * without a key. Mounted from the authed layout, which is the only place a real
 * user id exists.
 */
export function IdentifyUser({ userId }: { userId: string }) {
  const client = usePostHog();
  useEffect(() => {
    if (client && userId) client.identify(userId);
  }, [client, userId]);
  return null;
}
