'use client';

import { blackFridayCountdownLabel } from '@hale/types';
import { useEffect, useState } from 'react';
import type { Locale } from '~/i18n/routing';
import type { BlackFridayOffer } from '~/lib/promo/black-friday';
import { blackFridayEndsPrefix, blackFridaySentence } from '~/lib/promo/black-friday';
import { pricingCheckoutTarget } from './founding-checkout-link';

/**
 * Live hours:minutes until 23:59:59 America/Toronto.
 * The first paint uses the server clock. After that it ticks, and the whole
 * banner unmounts when it hits zero so a stale tab does not keep the sale up.
 */
export function useBlackFridayRemaining(endsAt: number, serverNow: number): number {
  const [nowMs, setNowMs] = useState(serverNow);
  useEffect(() => {
    const skew = serverNow - Date.now();
    const tick = () => setNowMs(Date.now() + skew);
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [serverNow]);
  return endsAt - nowMs;
}

export function BlackFridayCountdown({
  endsAt,
  serverNow,
  prefix,
}: {
  endsAt: number;
  serverNow: number;
  prefix: string;
}) {
  const label = blackFridayCountdownLabel(useBlackFridayRemaining(endsAt, serverNow));
  if (!label) return null;
  return (
    <span className="bf-count">
      {prefix}{' '}
      <time dateTime={new Date(endsAt).toISOString()} suppressHydrationWarning>
        {label}
      </time>
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
  const remaining = useBlackFridayRemaining(offer.endsAt, offer.serverNow);
  if (blackFridayCountdownLabel(remaining) === null) return null;
  const sentence = blackFridaySentence(
    locale,
    offer.plus?.banner ?? null,
    offer.max?.banner ?? null,
  );
  return (
    <div className="rd bf-banner" data-bf="1" data-bf-currency={offer.currency}>
      <div className="bf-banner-in v4-glass">
        <p className="bf-banner-copy">{sentence}</p>
        <BlackFridayCountdown
          endsAt={offer.endsAt}
          serverNow={offer.serverNow}
          prefix={blackFridayEndsPrefix(locale)}
        />
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
