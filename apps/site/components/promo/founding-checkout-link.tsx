'use client';

import { parseAttribution, serializeAttribution } from '@hale/types';
import type { ReactNode } from 'react';
import { ATTRIBUTION_STORAGE_KEY } from '~/lib/analytics/attribution';
import { useAnalytics } from '~/lib/analytics/posthog-provider';
import { APP_URL } from '~/lib/app-url';
import type { PromoPhase, PromoTier } from '~/lib/promo/holiday';

/**
 * The app's new-visitor join (phone code, then Stripe). A signed-in family
 * who lands there is sent on to the signed-in checkout. `/founding` does not
 * read a plan query — after the code the parent chooses Plus or Max — so the
 * chosen tier stays on the analytics event and is not put in the URL.
 *
 * The path stays `/founding`. The app 308s it to `/join`. A site deploy that
 * landed first would otherwise point at a `/join` the app does not have yet.
 * A later change switches this to `/join`, or drops the link when direct
 * checkout lands.
 */
export const FOUNDING_CHECKOUT_PATH = '/founding';

export function foundingCheckoutHref(appUrl: string = APP_URL): string {
  return `${appUrl.replace(/\/$/, '')}${FOUNDING_CHECKOUT_PATH}`;
}

/** The join URL, plus a query string that has no leading `?`. */
export function foundingCheckoutTarget(query = '', appUrl: string = APP_URL): string {
  const href = foundingCheckoutHref(appUrl);
  return query ? `${href}?${query}` : href;
}

/**
 * The "lock in the founding price" door. It opens the new-visitor join.
 * On tap it carries the tab's first-touch UTMs / gclid / fbclid in the query,
 * so attribution survives even when the visitor declined cookies (no cookie
 * is written here).
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
   * Which paid tier the visitor picked. Recorded on `promo_cta_click` only.
   * The join page does not read `plan`, so it is not added to the URL.
   */
  plan: PromoTier;
  className?: string;
  children: ReactNode;
}) {
  const capture = useAnalytics();
  const href = foundingCheckoutTarget();
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
          window.location.assign(foundingCheckoutTarget(query));
        }
      }}
    >
      {children}
    </a>
  );
}
