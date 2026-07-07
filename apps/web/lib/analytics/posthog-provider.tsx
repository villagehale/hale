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
 * The single posthog-js init config, privacy-first (hard rule #1). Exported as a
 * pure value so the privacy posture is unit-tested directly (the test asserts
 * recording is enabled AND masked, and exception capture is on) without a DOM.
 *
 *  - autocapture OFF — we only send the hand-picked key-loop events; no clicks,
 *    no form interactions are inferred.
 *  - session_recording ON, fully MASKED — Hale shows newborn/child PII, so the
 *    replay must never carry it:
 *      · maskAllInputs masks EVERY <input>/<textarea> value (names, DOB, email,
 *        address) — so anything a parent TYPES records as masked.
 *      · maskTextSelector masks the rendered TEXT inside any element tagged
 *        `[data-hale-pii]` — child names, ages, the health/feed/nap/milestone
 *        timeline, and Concierge chat content are tagged at the render sites, so
 *        the DOM replay keeps layout/labels/buttons while the PII reads as
 *        masked.
 *  - capture_exceptions ON — unhandled errors + promise rejections are captured
 *    into the SAME session, so an error is linkable to its replay. Console
 *    errors are left out (they may carry PII).
 *  - respect_dnt ON, plus opt-out-by-default capturing honoured by the browser.
 *  - capture_pageview ON — URLs only (our routes carry no PII).
 *  - persistence is the minimal first-party cookie+localStorage default.
 * Identity is the opaque user id only — set later via `identify`, never email.
 */
export const POSTHOG_PII_SELECTOR = '[data-hale-pii]';

export const POSTHOG_INIT_CONFIG = {
  autocapture: false,
  capture_pageview: true,
  disable_session_recording: false,
  session_recording: {
    maskAllInputs: true,
    maskTextSelector: POSTHOG_PII_SELECTOR,
  },
  capture_exceptions: true,
  respect_dnt: true,
} as const satisfies Partial<Parameters<typeof posthog.init>[1]>;

function initPostHog(): void {
  if (!KEY || posthog.__loaded) return;
  posthog.init(KEY, {
    api_host: HOST ?? 'https://us.i.posthog.com',
    ...POSTHOG_INIT_CONFIG,
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
 * Returns a function that reports an exception to PostHog, bound to the same
 * privacy gate as capture: no-ops without a key. Unhandled errors + rejections
 * are already captured automatically via `capture_exceptions`; this is the
 * explicit path for a React error boundary that catches a render error before it
 * reaches `window.onerror`. Only the error itself is sent — never extra props —
 * so a stack trace can't carry child/family PII.
 */
export function useCaptureException(): (error: unknown) => void {
  const client = usePostHog();
  return (error) => {
    if (!client) return;
    client.captureException(error);
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
