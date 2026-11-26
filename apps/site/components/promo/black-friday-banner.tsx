'use client';

import { blackFridayCountdownRemainingMs } from '@hale/types';
import { useEffect, useState } from 'react';
import type { Locale } from '~/i18n/routing';
import type { BlackFridayOffer } from '~/lib/promo/black-friday';
import { blackFridayCountdownCopy, blackFridaySentence } from '~/lib/promo/black-friday';
import { pricingCheckoutTarget } from './founding-checkout-link';

/**
 * "Ends Friday at midnight" in the visitor's zone, filled in after mount so
 * the server HTML and the first client paint match. Null once that Friday
 * has ended. The prices stay; only this sentence goes away.
 */
export function useBlackFridayCountdownCopy(serverNow: number, locale: Locale): string | null {
  const [copy, setCopy] = useState<string | null>(null);
  useEffect(() => {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const skew = serverNow - Date.now();
    const tick = () => {
      const now = Date.now() + skew;
      setCopy(blackFridayCountdownCopy(locale, blackFridayCountdownRemainingMs(now, timeZone)));
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [serverNow, locale]);
  return copy;
}

export function BlackFridayCountdown({ serverNow, locale }: { serverNow: number; locale: Locale }) {
  const copy = useBlackFridayCountdownCopy(serverNow, locale);
  if (!copy) return null;
  return (
    <span className="bf-count" data-bf-countdown="1">
      {copy}
    </span>
  );
}

function checkoutHref(plan: 'plus' | 'max', query: string): string {
  return pricingCheckoutTarget(plan, query);
}

/** Glass strip in the existing promo-bar slot. Desktop and mobile, above the header. */
export function BlackFridayBanner({
  offer,
  locale,
}: {
  offer: BlackFridayOffer;
  locale: Locale;
}) {
  const sentence = blackFridaySentence(
    locale,
    offer.plus?.banner ?? null,
    offer.max?.banner ?? null,
  );
  return (
    <div className="rd bf-banner" data-bf="1" data-bf-currency={offer.currency}>
      <div className="bf-banner-in v4-glass">
        <p className="bf-banner-copy">{sentence}</p>
        <BlackFridayCountdown serverNow={offer.serverNow} locale={locale} />
        <div className="bf-banner-actions">
          {offer.plus ? (
            <a className="hs-btn-primary" href={checkoutHref('plus', offer.checkoutQuery)}>
              Plus {offer.plus.saleLabel}
            </a>
          ) : null}
          {offer.max ? (
            <a className="hs-btn-primary" href={checkoutHref('max', offer.checkoutQuery)}>
              Max {offer.max.saleLabel}
            </a>
          ) : null}
        </div>
      </div>
    </div>
  );
}
