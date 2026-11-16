'use client';

import type { ReactNode } from 'react';
import { useAnalytics } from '~/lib/analytics/posthog-provider';
import { ATTRIBUTION_STORAGE_KEY } from '~/lib/analytics/attribution';
import { APP_URL } from '~/lib/app-url';
import type { PromoPhase, PromoTier } from '~/lib/promo/holiday';
import { parseAttribution, serializeAttribution } from '@hale/types';

/** The app page that starts founding checkout for a signed-in family. */
export const FOUNDING_CHECKOUT_PATH = '/settings/founding';

export function foundingCheckoutHref(appUrl: string = APP_URL): string {
  return `${appUrl.replace(/\/$/, '')}${FOUNDING_CHECKOUT_PATH}`;
}

/**
 * The "lock in the founding price" door. It goes to the app, where a signed-in
 * family starts Stripe Checkout. On tap it carries the tab's first-touch
 * UTMs / gclid / fbclid in the query, so attribution survives even when the
 * visitor declined cookies (no cookie is written here).
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
  /**
   * Which paid tier the visitor picked. Sent as `?plan=` so the app can open
   * the matching founding checkout. apps/web does not read it yet (Noah).
   */
  plan: PromoTier;
  className?: string;
  children: ReactNode;
}) {
  const capture = useAnalytics();
  const href = `${foundingCheckoutHref()}?plan=${plan}`;
  return (
    <a
      href={href}
      className={className}
      data-cta="promo_cta_click"
      data-cta-placement={placement}
      onClick={(event) => {
        capture('promo_cta_click', { cta_placement: placement, promo_phase: phase, currency, plan });
        let stored: string | null = null;
        try {
          stored = window.sessionStorage.getItem(ATTRIBUTION_STORAGE_KEY);
        } catch {
          stored = null;
        }
        const query = serializeAttribution(parseAttribution(stored ?? undefined));
        if (query) {
          event.preventDefault();
          window.location.assign(`${href}&${query}`);
        }
      }}
    >
      {children}
    </a>
  );
}
