'use client';

import type { PostHog } from 'posthog-js';
import { createContext, useContext, useEffect, useState } from 'react';
import type { Locale } from '~/i18n/routing';
import { type CapturedEvent, type EventProperties, PAGEVIEW, buildEvent } from './events';
import { type SessionLike, readFirstTouchSourceCode } from './source-code';

const KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY;
const HOST = process.env.NEXT_PUBLIC_POSTHOG_HOST;

/** True only when a key is configured — otherwise the whole layer is a no-op. */
export function analyticsEnabled(): boolean {
  return Boolean(KEY);
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
 *    that may set advertising cookies; it is not this client (google-ads-tag.tsx).
 *  - `autocapture: false` — no clicks, no form interactions, no rageclicks are inferred.
 *    Every event in the catalog is fired by a named call site.
 *  - `disable_session_recording: false` — replay is ON for the marketing site
 *    (2026-08-27, the Google Ads launch): the page is Hale's own copy, the visitor is
 *    anonymous, and watching where paid visitors stall is the one signal the funnel
 *    events cannot carry. Inputs are masked (`session_recording.maskAllInputs`), and
 *    `persistence: 'memory'` is unchanged, so a recording still writes nothing to the
 *    visitor's device and the legal pages' no-cookie claim stays true. (The APP
 *    records too, masked, and says so — apps/web/lib/analytics/posthog-provider.tsx.)
 *  - `capture_pageview: false` — the provider captures `$pageview` itself, AFTER
 *    resolving `source_code` and `locale`, so the first pageview of a visit carries its
 *    attribution. posthog-js fires its own during `init()`, which is one statement too
 *    early to stamp anything on.
 *  - `respect_dnt` + the masking pair, unchanged. `mask_all_text` governs autocapture
 *    element text (off anyway), not replay — replays show the site's own copy.
 */
export const POSTHOG_INIT_CONFIG = {
  autocapture: false,
  capture_pageview: false,
  disable_session_recording: false,
  session_recording: { maskAllInputs: true },
  persistence: 'memory',
  respect_dnt: true,
  mask_all_text: true,
  mask_all_element_attributes: true,
} as const satisfies Partial<Parameters<PostHog['init']>[1]>;

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
    if (!KEY) return;
    let active = true;
    const sourceCode = readFirstTouchSourceCode(window.location.search, sessionStorageOrNull());
    // An untagged visit has no source, and that stays ABSENT rather than becoming a
    // string like 'direct' — a bucket that means "no card" must not look like a card.
    const base: EventProperties = { locale, ...(sourceCode ? { source_code: sourceCode } : {}) };

    void import('posthog-js').then(({ default: posthog }) => {
      if (!active) return;
      if (!posthog.__loaded) {
        posthog.init(KEY, {
          api_host: HOST ?? 'https://us.i.posthog.com',
          ...POSTHOG_INIT_CONFIG,
        });
      }
      const pageview = buildEvent(PAGEVIEW, base);
      posthog.capture(pageview.event, pageview.properties);
      setAnalytics({ client: posthog, base });
    });
    return () => {
      active = false;
    };
  }, [locale]);

  return <PostHogContext.Provider value={analytics}>{children}</PostHogContext.Provider>;
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
