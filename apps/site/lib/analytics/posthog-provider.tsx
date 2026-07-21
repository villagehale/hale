'use client';

import type { PostHog } from 'posthog-js';
import { createContext, useContext, useEffect, useState } from 'react';
import { type AnalyticsEvent, buildEvent } from './events';

const KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY;
const HOST = process.env.NEXT_PUBLIC_POSTHOG_HOST;

/** True only when a key is configured — otherwise the whole layer is a no-op. */
export function analyticsEnabled(): boolean {
  return Boolean(KEY);
}

// The live client, shared through our own context. `posthog-js` (and its React
// bindings) are never imported at module scope — importing them statically pulls
// the ~50KB analytics core into first-load JS on the LCP-critical landing page.
// The client is loaded only after hydration (see below), so until it resolves —
// and always, when no key is configured — this stays null and capture is a no-op.
const PostHogContext = createContext<PostHog | null>(null);

/**
 * Wraps the marketing app. When a key is configured it loads posthog-js AFTER
 * hydration via dynamic import (keeping the analytics core out of the critical
 * bundle) and inits it privacy-first (hard rule #1): autocapture off, session
 * recording off, respect DNT, mask all inputs, pageviews only (URLs carry no
 * PII). Anonymous on the marketing site — we never identify a visitor. With no
 * key it renders children untouched: no import, no network, no errors.
 */
export function PostHogProvider({ children }: { children: React.ReactNode }) {
  const [client, setClient] = useState<PostHog | null>(null);

  useEffect(() => {
    if (!KEY) return;
    let active = true;
    void import('posthog-js').then(({ default: posthog }) => {
      if (!active) return;
      if (!posthog.__loaded) {
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
      setClient(posthog);
    });
    return () => {
      active = false;
    };
  }, []);

  return <PostHogContext.Provider value={client}>{children}</PostHogContext.Provider>;
}

/**
 * Returns a capture function bound to the privacy gate. Every property goes
 * through `buildEvent`, so identifying or non-primitive fields are stripped
 * before they reach PostHog. No-ops cleanly until the client has loaded (or when
 * analytics is disabled).
 */
export function useAnalytics(): (
  event: AnalyticsEvent,
  properties?: Record<string, unknown>,
) => void {
  const client = useContext(PostHogContext);
  return (event, properties) => {
    if (!client) return;
    const { event: name, properties: safe } = buildEvent(event, properties);
    client.capture(name, safe);
  };
}
