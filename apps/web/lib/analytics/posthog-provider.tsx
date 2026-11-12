'use client';

import type { CaptureResult, PostHog } from 'posthog-js';
import { createContext, useContext, useEffect, useState } from 'react';
import { type AnalyticsEvent, buildEvent } from './events';
import { posthogReplayEnabled, posthogWebEnabled } from './flags';
import { hasAnalyticsOptOut } from './opt-out';
import { POSTHOG_PROXY_PATH, posthogUiHost } from './posthog-proxy';

const KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY;

/** True only when a key is configured AND the web flag is on — otherwise a no-op. */
export function analyticsEnabled(): boolean {
  return Boolean(KEY) && posthogWebEnabled();
}

// The live client, shared through OUR OWN context. posthog-js AND its React
// bindings (posthog-js/react) are never imported at module scope, because a static
// import of EITHER pulls the ~50KB analytics core into first-load JS on every
// route. The client is loaded only after hydration (see the provider), so until it
// resolves — and always, when no key / web flag is configured — this stays null and
// every capture path no-ops.
const PostHogContext = createContext<PostHog | null>(null);

/**
 * Autocapture only on the phone-code login / sign-up door. Logged-in pages carry
 * children's names and calendar items; those clicks must not become $autocapture
 * events. Replay masking (`data-hale-pii`) is a separate layer.
 */
export const POSTHOG_AUTOCAPTURE_URL_ALLOWLIST = [
  /https?:\/\/[^/]+\/sign-in(?:\/)?(?:\?.*)?$/,
  /https?:\/\/[^/]+\/sign-up(?:\/)?(?:\?.*)?$/,
  /https?:\/\/[^/]+\/demo\/sign-in(?:\/)?(?:\?.*)?$/,
];

/**
 * /l/<code> is a bearer link: whoever holds the code can save a login for the family, so
 * the code never reaches PostHog. PostHog does not load on that page at all: a first load
 * there stores the URL as the person's initial URL, which the flags request sends past
 * `before_send`. Anything that still names one (a client-side visit, the page after it)
 * goes out as `/l/[code]`, raw or URL-encoded, in any string or key.
 */
const LOGIN_LINK_CODE = /(\/|%2F)l(\/|%2F)[^/?#&\s"'\\]+/gi;

export function isLoginLinkPath(pathname: string): boolean {
  return pathname.startsWith('/l/');
}

function redactCodes<T>(value: T): T {
  if (typeof value === 'string') return value.replace(LOGIN_LINK_CODE, '$1l$2[code]') as T;
  if (Array.isArray(value)) return value.map(redactCodes) as T;
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [redactCodes(key), redactCodes(inner)]),
    ) as T;
  }
  return value;
}

export function redactLoginLinkCodes(event: CaptureResult | null): CaptureResult | null {
  if (!event) return null;
  return {
    ...event,
    properties: redactCodes(event.properties),
    ...(event.$set ? { $set: redactCodes(event.$set) } : {}),
    ...(event.$set_once ? { $set_once: redactCodes(event.$set_once) } : {}),
  };
}

/**
 * The single posthog-js init config, privacy-first (hard rule #1). Exported as a
 * pure value so the privacy posture is unit-tested directly.
 *
 *  - autocapture ON only for the login/sign-up funnel (url allowlist above).
 *  - pageviews + pageleave ON — URLs only (our routes carry no PII).
 *  - session recording OFF unless NEXT_PUBLIC_POSTHOG_REPLAY_ENABLED is exactly
 *    `true` (default preserves VIL-483). When on, the masking pair is defence
 *    in depth:
 *      · maskAllInputs masks EVERY <input>/<textarea> value.
 *      · phone and code fields are also tagged `ph-mask` / `data-hale-mask-input`.
 *      · maskTextSelector masks rendered TEXT inside `[data-hale-pii]` —
 *        children's names, calendar items, Ask Hale chat.
 *  - heatmaps ON (project setting must also be on). Surveys ON so a PostHog web
 *    survey can target the logged-in dashboard; no survey copy is created here.
 *  - capture_exceptions ON. Console errors are left out (they may carry PII).
 *  - respect_dnt ON, plus the first-party opt-out in opt-out.ts.
 *  - events go through the /ingest rewrite, not *.i.posthog.com.
 *  - before_send takes any /l/<code> out of every event (see redactLoginLinkCodes).
 * Identity is the HMAC'd family id only — set later via `identify`, never email.
 */
export const POSTHOG_PII_SELECTOR = '[data-hale-pii], [data-hale-mask-input]';
/**
 * Classes/attrs we stamp on phone and code fields, and on the /l/<code> login page.
 * `ph-mask` is rrweb's default maskTextClass; `ph-no-capture` blocks the subtree whole.
 */
export const POSTHOG_MASK_INPUT_SELECTOR = 'ph-mask ph-no-capture';

export const POSTHOG_INIT_CONFIG = {
  autocapture: { url_allowlist: POSTHOG_AUTOCAPTURE_URL_ALLOWLIST },
  capture_pageview: 'history_change' as const,
  capture_pageleave: true,
  capture_heatmaps: true,
  disable_surveys: false,
  disable_session_recording: !posthogReplayEnabled(),
  session_recording: {
    maskAllInputs: true,
    maskTextSelector: POSTHOG_PII_SELECTOR,
  },
  capture_exceptions: true,
  respect_dnt: true,
  before_send: redactLoginLinkCodes,
} satisfies Partial<Parameters<PostHog['init']>[1]>;

/**
 * Wraps the app. posthog-js (~50KB gzipped) is loaded AFTER hydration via a dynamic
 * import inside the effect, so the analytics core is code-split OUT of every route's
 * initial client bundle. Until it resolves (and whenever the web flag / key is off)
 * children render untouched with no provider mounted.
 */
export function PostHogProvider({ children }: { children: React.ReactNode }) {
  const [client, setClient] = useState<PostHog | null>(null);

  useEffect(() => {
    if (!KEY || !posthogWebEnabled() || isLoginLinkPath(window.location.pathname)) return;
    let cancelled = false;
    void import('posthog-js').then(({ default: posthog }) => {
      if (cancelled) return;
      if (!posthog.__loaded) {
        posthog.init(KEY, {
          api_host: POSTHOG_PROXY_PATH,
          ui_host: posthogUiHost(),
          ...POSTHOG_INIT_CONFIG,
          loaded: (ph) => {
            if (hasAnalyticsOptOut()) ph.opt_out_capturing();
          },
        });
      }
      if (hasAnalyticsOptOut()) {
        posthog.opt_out_capturing();
        return;
      }
      setClient(posthog);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return <PostHogContext.Provider value={client}>{children}</PostHogContext.Provider>;
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
  const client = useContext(PostHogContext);
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
  const client = useContext(PostHogContext);
  return (error) => {
    if (!client) return;
    client.captureException(error);
  };
}

/**
 * Identify the current user by their HASHED family id only (never email/name/
 * phone, never the raw uuid). The hash is computed on the server with
 * POSTHOG_ID_SALT and passed in. No-ops without a client. Mounted from the
 * authed layout, which is the only place a real family id exists.
 */
export function IdentifyUser({ userId }: { userId: string }) {
  const client = useContext(PostHogContext);
  useEffect(() => {
    if (client && userId) client.identify(userId);
  }, [client, userId]);
  return null;
}
