'use client';

import {
  BLACK_FRIDAY_WINDOW_END_MS,
  blackFridayCountdownClock,
  blackFridayCountdownRemainingMs,
} from '@hale/types';
import { useEffect, useState } from 'react';
import type { Locale } from '~/i18n/routing';
import type { BlackFridayOffer } from '~/lib/promo/black-friday';
import {
  BLACK_FRIDAY_COUNTDOWN_HOLD,
  blackFridayCountdownCopy,
  blackFridayCountdownPair,
  blackFridayEndsInLabel,
  blackFridayPlanButton,
  blackFridaySentence,
} from '~/lib/promo/black-friday';
import { FoundingCheckoutLink } from './founding-checkout-link';

/** A tab left open past the gate reloads onto the season bar. A preview pin does not. */
function useRestoreWhenGateCloses(serverNow: number, pinned: boolean) {
  useEffect(() => {
    if (pinned) return;
    const skew = serverNow - Date.now();
    const remaining = BLACK_FRIDAY_WINDOW_END_MS - (Date.now() + skew);
    if (remaining <= 0) {
      window.location.reload();
      return;
    }
    const id = window.setTimeout(() => window.location.reload(), remaining);
    return () => window.clearTimeout(id);
  }, [serverNow, pinned]);
}

/**
 * Null until mount, then the remaining milliseconds. The first paint matches
 * the server: a hidden placeholder of the same width, then the real clock.
 */
function useBlackFridayCountdownRemaining(serverNow: number): number | null {
  const [remaining, setRemaining] = useState<number | null>(null);
  useEffect(() => {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const skew = serverNow - Date.now();
    const tick = () => {
      setRemaining(blackFridayCountdownRemainingMs(Date.now() + skew, timeZone));
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [serverNow]);
  return remaining;
}

/**
 * The midnight sentence and "Ends in HH:MM:SS", side by side. The server HTML
 * is a hidden placeholder of the same width. Both lines go away together once
 * the visitor's Friday ends. The prices stay.
 */
export function BlackFridayCountdown({ serverNow, locale }: { serverNow: number; locale: Locale }) {
  const remaining = useBlackFridayCountdownRemaining(serverNow);
  const pair = remaining === null ? null : blackFridayCountdownPair(locale, remaining);
  if (remaining !== null && !pair) return null;
  const when = pair?.when ?? blackFridayCountdownCopy(locale, 1);
  const clock = pair ? blackFridayCountdownClock(remaining ?? 0) : BLACK_FRIDAY_COUNTDOWN_HOLD;
  return (
    <span
      className={pair ? 'bf-count' : 'bf-count is-hold'}
      data-bf-countdown="1"
      aria-hidden={pair ? undefined : true}
    >
      <span className="bf-count-when">{when}</span>
      <span className="bf-count-left">
        <span className="bf-count-sep"> · </span>
        {blackFridayEndsInLabel(locale)} <span className="bf-count-time">{clock}</span>
      </span>
    </span>
  );
}

/** Glass strip in the existing promo-bar slot. Desktop and mobile, above the header. */
export function BlackFridayBanner({
  offer,
  locale,
}: {
  offer: BlackFridayOffer;
  locale: Locale;
}) {
  useRestoreWhenGateCloses(offer.serverNow, offer.checkoutQuery.length > 0);
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
            <FoundingCheckoutLink
              className="hs-btn-primary"
              placement="bf_banner"
              phase="black_friday"
              currency={offer.currency}
              plan="plus"
              query={offer.checkoutQuery}
            >
              {blackFridayPlanButton(locale, 'plus', offer.plus.saleLabel)}
            </FoundingCheckoutLink>
          ) : null}
          {offer.max ? (
            <FoundingCheckoutLink
              className="hs-btn-primary"
              placement="bf_banner"
              phase="black_friday"
              currency={offer.currency}
              plan="max"
              query={offer.checkoutQuery}
            >
              {blackFridayPlanButton(locale, 'max', offer.max.saleLabel)}
            </FoundingCheckoutLink>
          ) : null}
        </div>
      </div>
    </div>
  );
}
