'use client';

import { parseAttribution } from '@hale/types';
import { usePathname } from 'next/navigation';
import type { PostHog } from 'posthog-js';
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { Locale } from '~/i18n/routing';
import { CONSENT_EVENT, readConsent } from '~/lib/site/consent';
import { readFirstTouchAttribution } from './attribution';
import { type CapturedEvent, type EventProperties, PAGEVIEW, buildEvent } from './events';
import { posthogReplayEnabled, posthogWebEnabled } from './flags';
import { createFunnelViewTracker } from './funnel-views';
import { hasAnalyticsOptOut } from './opt-out';
import { POSTHOG_PROXY_PATH, posthogUiHost } from './posthog-proxy';
import { type SessionLike, readFirstTouchSourceCode } from './source-code';
import { hasSecretQuery, redactSecretEvent } from './url-secrets';

const KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY;

/** True only when a key is configured AND the web flag is on — otherwise a no-op. */
export function analyticsEnabled(): boolean {
  return Boolean(KEY) && posthogWebEnabled();
}

/**
 * The single posthog-js init config for the MARKETING site. Exported as a pure value so
 * the posture is asserted directly, without a browser (see posthog-config.test.ts).
 *
 * This site is anonymous and EXPLICIT-ONLY. Nothing here infers behaviour, and nothing
 * here writes to a visitor's device:
 *
 *  - `persistence: 'memory'` — PostHog writes nothing to a visitor's device. Not a
 *    cookie, not localStorage: the distinct id lives in a JS variable and dies with the
 *    tab. It costs cross-visit stitching, which on a site whose only conversion leaves
 *    for an SMS composer was never measurable anyway. Google Ads is a separate head tag
 *    that may set advertising cookies; it is not this client (google-ads-client.ts).
 *    ACCEPTED TRADEOFF (2026-08 ad-week audit): the distinct id also dies on every
 *    NAVIGATION (each page load is a fresh id), so "sessions" ≈ pageviews and a
 *    cross-page funnel (landing → /text → CTA) cannot be stitched into one visitor.
 *    Read the funnel as per-page event counts with `source_code`/`cta_placement`
 *    breakdowns, not as user journeys.
 *  - autocapture ON only for the landing page and /privacy / /terms (url allowlist).
 *    Named catalog events still fire everywhere else. The copy on those pages is
 *    Hale's, not a parent's.
 *  - session recording OFF unless NEXT_PUBLIC_POSTHOG_REPLAY_ENABLED is exactly
 *    `true` (and the visitor has accepted cookies). Inputs stay masked. Persistence
 *    is still memory, so a recording writes nothing to the visitor's device.
 *  - heatmaps ON (project setting must also be on). Surveys stay OFF here — web
 *    surveys are wired on the logged-in dashboard, never on this site, never SMS.
 *  - `capture_pageview: 'history_change'` + `capture_pageleave: true` — posthog-js
 *    captures the first pageview and every client-side navigation, plus page leaves.
 *    `source_code` and `locale` are REGISTERED as super properties in the `loaded`
 *    callback, which posthog-js runs before its initial pageview, so every event —
 *    pageviews included — carries the visit's attribution. The super properties live in
 *    memory (`persistence: 'memory'`); the first-touch code itself is held in
 *    sessionStorage by source-code.ts, never a cookie.
 *  - `capture_performance.web_vitals: true` — LCP/CLS/INP/FCP, anonymous numbers.
 *  - `respect_dnt` + the masking pair, unchanged. `mask_all_text` governs autocapture
 *    element text (off anyway), not replay — replays show the site's own copy.
 */
/** Landing (`/`, `/fr`, `/zh`) plus /privacy and /terms in every locale. */
export const POSTHOG_AUTOCAPTURE_URL_ALLOWLIST = [
  /https?:\/\/[^/]+\/?(\?.*)?$/,
  /https?:\/\/[^/]+\/(en|fr|zh)\/?(\?.*)?$/,
  /https?:\/\/[^/]+\/((en|fr|zh)\/)?privacy(?:\/)?(?:\?.*)?$/,
  /https?:\/\/[^/]+\/((en|fr|zh)\/)?terms(?:\/)?(?:\?.*)?$/,
];

const CHECKOUT_SESSION_QUERY = /([?&]|%3F|%26)session_id(=|%3D)[^&#"'\\\s]*/gi;

/** The success URL's checkout id can send a code and read the phone. It stays out of analytics. */
export function redactCheckoutSessionIds(value: string): string {
  return value.replace(CHECKOUT_SESSION_QUERY, '$1session_id$2[session]');
}

function redactMarketingValue<T>(value: T): T {
  if (typeof value === 'string') return redactCheckoutSessionIds(value) as T;
  if (Array.isArray(value)) return value.map(redactMarketingValue) as T;
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [
        redactMarketingValue(key),
        redactMarketingValue(inner),
      ]),
    ) as T;
  }
  return value;
}

export function redactMarketingEvent<
  T extends { properties?: unknown; $set?: unknown; $set_once?: unknown } | null,
>(event: T): T {
  if (!event) return event;
  return {
    ...event,
    properties: redactMarketingValue(event.properties),
    ...(event.$set ? { $set: redactMarketingValue(event.$set) } : {}),
    ...(event.$set_once ? { $set_once: redactMarketingValue(event.$set_once) } : {}),
  };
}

export const POSTHOG_INIT_CONFIG = {
  autocapture: { url_allowlist: POSTHOG_AUTOCAPTURE_URL_ALLOWLIST },
  capture_pageview: 'history_change' as const,
  capture_pageleave: true,
  capture_heatmaps: true,
  disable_surveys: true,
  capture_performance: { web_vitals: true },
  disable_session_recording: !posthogReplayEnabled(),
  session_recording: { maskAllInputs: true },
  persistence: 'memory' as const,
  respect_dnt: true,
  mask_all_text: false,
  mask_all_element_attributes: true,
  // The checkout id is stripped first. url-secrets then strips every other bearer,
  // including a session id, so main's attribution redaction and this checkout stay.
  before_send: (event) => redactSecretEvent(redactMarketingEvent(event)),
} satisfies Partial<Parameters<PostHog['init']>[1]>;

interface Analytics {
  client: PostHog | null;
  /** Stamped on every event, overriding any call site — see {@link useAnalytics}. */
  base: EventProperties;
}

// The live client, shared through our own context. `posthog-js` (and its React
// bindings) are never imported at module scope — importing them statically pulls
// the ~50KB analytics core into first-load JS on the LCP-critical landing page.
// The client is loaded only after hydration (see below), so until it resolves —
// and always, when no key is configured — this stays null and capture is a no-op.
const PostHogContext = createContext<Analytics>({ client: null, base: {} });

/** `sessionStorage`, or null where the browser refuses it (Safari private mode). */
function sessionStorageOrNull(): SessionLike | null {
  try {
    return window.sessionStorage;
  } catch {
    // Not masking a bug (rule #8): a browser that denies storage is a supported
    // visitor, and the fallback is named — URL-only attribution, see source-code.ts.
    return null;
  }
}

/**
 * Wraps the marketing app. When a key is configured it loads posthog-js AFTER
 * hydration via dynamic import (keeping the analytics core out of the critical
 * bundle) and inits it privacy-first (hard rule #1) from {@link POSTHOG_INIT_CONFIG}.
 * With no key it renders children untouched: no import, no network, no errors.
 *
 * ONE effect does the whole sequence on purpose — resolve attribution, init, pageview —
 * because the order is the contract. A `$pageview` captured before `source_code` is
 * known is a visit that can never be attributed to the card that produced it, and that
 * is the one question this site's analytics exists to answer.
 */
export function PostHogProvider({
  locale,
  children,
}: {
  locale: Locale;
  children: React.ReactNode;
}) {
  const [analytics, setAnalytics] = useState<Analytics>({ client: null, base: {} });

  useEffect(() => {
    // A page whose URL holds a secret (the checkout success page's session id) does not
    // load PostHog: the first load would send that URL in the flags request.
    if (
      !KEY ||
      !posthogWebEnabled() ||
      hasSecretQuery(window.location.search) ||
      hasSecretQuery(window.location.hash)
    ) {
      return;
    }
    let active = true;
    const storage = sessionStorageOrNull();
    // A join tag matches the card grammar and must not become a super property.
    // The text door still reads the raw code; only analytics goes through the gate.
    const sourceCode = parseAttribution({
      source_code: readFirstTouchSourceCode(window.location.search, storage) ?? undefined,
    }).source_code;
    const attribution = readFirstTouchAttribution(window.location.search, storage);
    // An untagged visit has no source, and that stays ABSENT rather than becoming a
    // string like 'direct' — a bucket that means "no card" must not look like a card.
    const base: EventProperties = {
      locale,
      ...(sourceCode ? { source_code: sourceCode } : {}),
      ...attribution,
    };

    const start = () => {
      if (!active || readConsent() !== 'granted' || hasAnalyticsOptOut()) return;
      void import('posthog-js').then(({ default: posthog }) => {
        if (!active || readConsent() !== 'granted') return;
        if (!posthog.__loaded) {
          posthog.init(KEY, {
            api_host: POSTHOG_PROXY_PATH,
            ui_host: posthogUiHost(),
            ...POSTHOG_INIT_CONFIG,
            // Runs before posthog-js captures its initial pageview (see the config note).
            loaded: (ph) => {
              ph.register(buildEvent(PAGEVIEW, base).properties);
              if (hasAnalyticsOptOut()) ph.opt_out_capturing();
            },
          });
        } else {
          // A locale switch re-runs this effect on an already-loaded client: restamp the
          // super properties. The switch is a URL change, so history_change counts it.
          posthog.register(buildEvent(PAGEVIEW, base).properties);
        }
        if (hasAnalyticsOptOut()) {
          posthog.opt_out_capturing();
          return;
        }
        setAnalytics({ client: posthog, base });
      });
    };

    start();
    window.addEventListener(CONSENT_EVENT, start);
    return () => {
      active = false;
      window.removeEventListener(CONSENT_EVENT, start);
    };
  }, [locale]);

  return (
    <PostHogContext.Provider value={analytics}>
      <FunnelPageViews />
      {children}
    </PostHogContext.Provider>
  );
}

/**
 * Returns a capture function bound to the privacy gate. Every property goes
 * through `buildEvent`, so identifying or non-primitive fields are stripped
 * before they reach PostHog. No-ops cleanly until the client has loaded (or when
 * analytics is disabled).
 *
 * The base properties are merged LAST: `source_code` and `locale` are facts about the
 * visit, not arguments, and a call site that passes its own must not be able to
 * relabel where a parent came from.
 */
export function useAnalytics(): (
  event: CapturedEvent,
  properties?: Record<string, unknown>,
) => void {
  const { client, base } = useContext(PostHogContext);
  return (event, properties) => {
    if (!client) return;
    const { event: name, properties: safe } = buildEvent(event, { ...properties, ...base });
    client.capture(name, safe);
  };
}

/**
 * Whether the deferred client has resolved and capture actually sends.
 *
 * Needed by any caller that LATCHES — the scroll tracker records which depths it has
 * already reported, and marking one against a capture that silently no-opped would lose
 * it for the rest of the view. The no-op window is real (a dynamic import, plus forever
 * when no key is configured), so it is a state a caller can read rather than a silence
 * it has to guess at (rule #11).
 */
export function useAnalyticsReady(): boolean {
  return useContext(PostHogContext).client !== null;
}

/** The site's funnel page views (lib/analytics/funnel-views.ts). Renders nothing. */
function FunnelPageViews(): null {
  const pathname = usePathname();
  const capture = useAnalytics();
  const ready = useAnalyticsReady();
  const tracker = useRef(createFunnelViewTracker());

  useEffect(() => {
    const view = tracker.current.observe(pathname, ready);
    if (view) capture(view);
  }, [capture, pathname, ready]);

  return null;
}
