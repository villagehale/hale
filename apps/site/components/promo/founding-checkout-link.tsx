'use client';

import { parseAttribution, serializeAttribution } from '@hale/types';
import type { ReactNode } from 'react';
import { ATTRIBUTION_STORAGE_KEY } from '~/lib/analytics/attribution';
import { useAnalytics } from '~/lib/analytics/posthog-provider';
import type { PromoPhase, PromoTier } from '~/lib/promo/holiday';

/**
 * Plus and Max go straight to Stripe Checkout on this site. The tier is in the
 * query. On tap, first-touch UTMs / gclid / fbclid ride along, so attribution
 * survives even when the visitor declined cookies (no cookie is written here).
 */
export function pricingCheckoutPath(plan: PromoTier): string {
  return `/api/checkout?tier=${plan}`;
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
        try {
          stored = window.sessionStorage.getItem(ATTRIBUTION_STORAGE_KEY);
        } catch {
          stored = null;
        }
        const query = serializeAttribution(parseAttribution(stored ?? undefined));
        if (query) {
          event.preventDefault();
          window.location.assign(pricingCheckoutTarget(plan, query));
        }
      }}
    >
      {children}
    </a>
  );
}
