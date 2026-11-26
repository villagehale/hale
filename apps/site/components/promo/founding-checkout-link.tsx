'use client';

import {
  ANALYTICS_DISTINCT_ID_KEY,
  type Attribution,
  analyticsDistinctId,
  mergeFirstTouch,
  parseAttribution,
  serializeAttribution,
} from '@hale/types';
import type { ReactNode } from 'react';
import { ATTRIBUTION_STORAGE_KEY } from '~/lib/analytics/attribution';
import { useAnalytics, useConsentedDistinctId } from '~/lib/analytics/posthog-provider';
import { readFirstTouchSourceCode } from '~/lib/analytics/source-code';
import { openDirectCheckout } from '~/lib/billing/checkout-client';
import type { PromoPhase, PromoTier } from '~/lib/promo/holiday';
import { readConsent } from '~/lib/site/consent';

/**
 * Plus and Max go straight to Stripe Checkout on this site. The tier is in the
 * query. On tap, first-touch UTMs / gclid / fbclid / msclkid ride along, plus the
 * validated card code (the attribution reader drops `source_code` from the URL).
 * A consented PostHog distinct id rides only when that client is loaded. No
 * cookie is written here.
 */
export function pricingCheckoutPath(plan: PromoTier): string {
  return `/api/checkout?tier=${plan}`;
}

/**
 * Query string for /api/checkout, with no leading `?`. `source_code` comes only
 * from the validated card code, never from a `source_code` param on the landing
 * URL or in stored attribution. The distinct id is added only when it passes
 * the consented-id check.
 */
export function pricingCheckoutQuery(input: {
  stored: string | null;
  search?: string | null;
  sourceCode: string | null;
  distinctId: string | null;
}): string {
  const remembered = dropSourceCode(parseAttribution(input.stored ?? undefined));
  const fromUrl = dropSourceCode(parseAttribution(input.search ?? undefined));
  const attribution = dropSourceCode(mergeFirstTouch(remembered, fromUrl));
  const code = parseAttribution({ source_code: input.sourceCode ?? undefined }).source_code;
  if (code) attribution.source_code = code;
  const params = new URLSearchParams(serializeAttribution(attribution));
  const distinct = analyticsDistinctId(input.distinctId);
  if (distinct) params.set(ANALYTICS_DISTINCT_ID_KEY, distinct);
  return params.toString();
}

/** Card codes are not taken from a landing URL or from stored attribution under this name. */
function dropSourceCode(attribution: Attribution): Attribution {
  const { source_code, ...rest } = attribution;
  void source_code;
  return rest;
}

/** The checkout path, plus a query string that has no leading `?`. */
export function pricingCheckoutTarget(plan: PromoTier, query = ''): string {
  const href = pricingCheckoutPath(plan);
  return query ? `${href}&${query}` : href;
}

/**
 * The sale button. A plain link, so a click is a GET that redirects to Stripe.
 * Nothing on this site asks for a phone or an account first.
 */
export function FoundingCheckoutLink({
  placement,
  phase,
  currency,
  plan,
  className,
  children,
}: {
  placement: string;
  phase: PromoPhase;
  currency: 'CAD' | 'USD';
  /** Which paid tier the visitor picked. It is the checkout query, and the analytics event. */
  plan: PromoTier;
  className?: string;
  children: ReactNode;
}) {
  const capture = useAnalytics();
  const distinctId = useConsentedDistinctId();
  const href = pricingCheckoutTarget(plan);
  return (
    <a
      href={href}
      className={className}
      data-cta="promo_cta_click"
      data-cta-placement={placement}
      onClick={(event) => {
        capture('promo_cta_click', {
          cta_placement: placement,
          promo_phase: phase,
          currency,
          plan,
        });
        let stored: string | null = null;
        let sourceCode: string | null = null;
        let search = '';
        try {
          stored = window.sessionStorage.getItem(ATTRIBUTION_STORAGE_KEY);
          search = window.location.search;
          sourceCode = readFirstTouchSourceCode(search, window.sessionStorage);
        } catch {
          stored = null;
          sourceCode = null;
        }
        const query = pricingCheckoutQuery({ stored, search, sourceCode, distinctId });
        const target = query ? pricingCheckoutTarget(plan, query) : href;
        const fbq = (window as Window & { fbq?: (...args: unknown[]) => void }).fbq;
        if (readConsent() === 'granted' && typeof fbq === 'function') {
          event.preventDefault();
          void openDirectCheckout({
            href: target,
            fbq,
            storage: window.sessionStorage,
            assign: (url) => window.location.assign(url),
          });
          return;
        }
        if (query) {
          event.preventDefault();
          window.location.assign(target);
        }
      }}
    >
      {children}
    </a>
  );
}
