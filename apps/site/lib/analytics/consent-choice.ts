import type { ConsentChoice } from '~/lib/site/consent';

/**
 * Posts the banner choice to our own route. The route is what talks to PostHog,
 * and only when FUNNEL_ATTRIBUTION_ENABLED is exactly true. This request sets
 * no cookie and sends none (`credentials: 'omit'`). No distinct id leaves the
 * browser. A missing product key skips the request: the project key is not
 * available here and must not be inlined.
 */
export function consentChoiceRequest(
  choice: ConsentChoice,
): { url: string; init: RequestInit } | null {
  if (!process.env.NEXT_PUBLIC_POSTHOG_KEY) return null;
  return {
    url: '/api/analytics/consent',
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ choice }),
      credentials: 'omit',
      keepalive: true,
      cache: 'no-store',
    },
  };
}

export function reportConsentChoice(choice: ConsentChoice): void {
  const request = consentChoiceRequest(choice);
  if (!request || typeof fetch !== 'function') return;
  void fetch(request.url, request.init).catch(() => undefined);
}
