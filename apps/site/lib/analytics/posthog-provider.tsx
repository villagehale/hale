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
 * Initialize posthog-js once, privacy-first (hard rule #1): autocapture off,
 * session recording off, respect DNT, mask all inputs, pageviews only (URLs
 * carry no PII). Anonymous on the marketing site — we never identify a visitor.
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
 * Wraps the marketing app. With no key configured it renders children untouched
 * — no init, no network, no errors — so the site ships safely now and starts
 * collecting once the key is added.
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
