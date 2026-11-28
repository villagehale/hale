'use client';

import {
  BLACK_FRIDAY_WINDOW_END_MS,
  blackFridayCountdownClock,
  blackFridayCountdownRemainingMs,
} from '@hale/types';
import { type MouseEvent, useEffect, useState } from 'react';
import { localeHref } from '~/i18n/navigation';
import type { Locale } from '~/i18n/routing';
import type { BlackFridayOffer } from '~/lib/promo/black-friday';
import {
  BLACK_FRIDAY_COUNTDOWN_HOLD,
  BLACK_FRIDAY_DISMISS_KEY,
  blackFridayBarLabel,
  blackFridayClockLabels,
  blackFridayCloseLabel,
  blackFridayEndsInLabel,
  blackFridayEndsLine,
  blackFridayPlainAmount,
  blackFridaySeePrices,
  blackFridayShortPriceLine,
} from '~/lib/promo/black-friday';
import { bfInter, bfMono, heroBrush } from '~/lib/site/display-fonts';

const DISMISS_EVENT = 'hale-bf-dismiss';

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

/** Session hide shared by the top bar and the sticky. Checkout is untouched. */
export function useBlackFridayDismissed(): {
  dismissed: boolean;
  dismiss: (event: MouseEvent<HTMLButtonElement>) => void;
} {
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    try {
      if (sessionStorage.getItem(BLACK_FRIDAY_DISMISS_KEY) === '1') setDismissed(true);
    } catch {
      // A private window can refuse storage. The bar stays up.
    }
    const onDismiss = () => setDismissed(true);
    window.addEventListener(DISMISS_EVENT, onDismiss);
    return () => window.removeEventListener(DISMISS_EVENT, onDismiss);
  }, []);
  const dismiss = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    try {
      sessionStorage.setItem(BLACK_FRIDAY_DISMISS_KEY, '1');
    } catch {
      // This tab still hides the bars. A reload may show them again.
    }
    setDismissed(true);
    window.dispatchEvent(new Event(DISMISS_EVENT));
  };
  return { dismissed, dismiss };
}

/**
 * HH, MM and SS beside "Ends in". Hidden once the visitor's Friday ends.
 * The server HTML is a same-width placeholder so the row does not jump.
 */
function BlackFridayCount({
  serverNow,
  locale,
  labeled,
}: {
  serverNow: number;
  locale: Locale;
  labeled: boolean;
}) {
  const remaining = useBlackFridayCountdownRemaining(serverNow);
  if (remaining !== null && remaining <= 0) return null;
  const clock = remaining === null ? BLACK_FRIDAY_COUNTDOWN_HOLD : blackFridayCountdownClock(remaining);
  const [hh = '88', mm = '88', ss = '88'] = clock.split(':');
  const [hours, minutes, seconds] = blackFridayClockLabels(locale);
  const live = remaining !== null;
  const units = [
    { value: hh, label: hours },
    { value: mm, label: minutes },
    { value: ss, label: seconds },
  ];
  const chip = (
    <span
      className={live ? 'bf-clock' : 'bf-clock is-hold'}
      data-bf-countdown="1"
      aria-hidden={live ? undefined : true}
    >
      {units.map((unit, index) => (
        <span key={unit.label} className="bf-unit-wrap">
          {index > 0 ? (
            <span className={`bf-colon ${bfInter.className}`} aria-hidden="true">
              :
            </span>
          ) : null}
          <span className="bf-unit">
            <span className={`bf-digit ${bfInter.className}`}>{unit.value}</span>
            <span className={`bf-unit-label ${bfMono.className}`}>{unit.label}</span>
          </span>
        </span>
      ))}
    </span>
  );
  if (!labeled) return chip;
  return (
    <span className="bf-count">
      <span className={`bf-ends-in ${bfInter.className}`}>{blackFridayEndsInLabel(locale)}</span>
      {chip}
    </span>
  );
}

/** The chip alone. The sticky keeps its own midnight line when this hides. */
export function BlackFridayClock({ serverNow, locale }: { serverNow: number; locale: Locale }) {
  return <BlackFridayCount serverNow={serverNow} locale={locale} labeled={false} />;
}

function PriceLine({ offer, locale }: { offer: BlackFridayOffer; locale: Locale }) {
  const pieces = [
    offer.plus
      ? {
          name: 'Plus' as const,
          was: blackFridayPlainAmount(locale, offer.plus.regular, false),
          now: blackFridayPlainAmount(locale, offer.plus.sale, true),
        }
      : null,
    offer.max
      ? {
          name: 'Max' as const,
          was: blackFridayPlainAmount(locale, offer.max.regular, false),
          now: blackFridayPlainAmount(locale, offer.max.sale, true),
        }
      : null,
  ].filter((piece) => piece !== null);
  return (
    <span className={`bf-prices ${bfInter.className}`}>
      {pieces.map((piece, index) => (
        <span key={piece.name}>
          {index > 0 ? ' · ' : null}
          {piece.name} <s>{piece.was}</s> {piece.now}
        </span>
      ))}
    </span>
  );
}

/** Desktop row: struck price, Ends in, the clock, See prices. */
function BlackFridayDesktopCluster({ offer, locale }: { offer: BlackFridayOffer; locale: Locale }) {
  return (
    <span className="bf-desk">
      <span className={`bf-sticker ${heroBrush.className}`}>Cyber Monday</span>
      <PriceLine offer={offer} locale={locale} />
      <BlackFridayCount serverNow={offer.serverNow} locale={locale} labeled />
      <span className={`bf-see ${bfInter.className}`}>{blackFridaySeePrices(locale)}</span>
    </span>
  );
}

/**
 * One row shared by the mobile top bar and the sticky.
 * Today's price, no strike and no unit, then the midnight line.
 */
export function BlackFridayMobileCluster({
  offer,
  locale,
}: {
  offer: BlackFridayOffer;
  locale: Locale;
}) {
  return (
    <span className="bf-mob">
      <span className="bf-lead">
        <span className={`bf-sticker ${heroBrush.className}`}>Cyber Monday</span>
        <span className={`bf-prices ${bfInter.className}`}>{blackFridayShortPriceLine(locale, offer)}</span>
        <span className={`bf-ends ${bfMono.className}`}>{blackFridayEndsLine(locale)}</span>
      </span>
      <BlackFridayClock serverNow={offer.serverNow} locale={locale} />
      <span className={`bf-see ${bfInter.className}`}>{blackFridaySeePrices(locale)}</span>
    </span>
  );
}

/** Sibling of the link, so the control is not a button inside an anchor. */
export function BlackFridayClose({
  locale,
  onDismiss,
}: {
  locale: Locale;
  onDismiss: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      type="button"
      className={`bf-close ${bfInter.className}`}
      aria-label={blackFridayCloseLabel(locale)}
      onClick={onDismiss}
    >
      ×
    </button>
  );
}

/** Black bar in the promo-bar slot. The whole cluster links to pricing. */
export function BlackFridayBanner({
  offer,
  locale,
}: {
  offer: BlackFridayOffer;
  locale: Locale;
}) {
  useRestoreWhenGateCloses(offer.serverNow, offer.checkoutQuery.length > 0);
  const { dismissed, dismiss } = useBlackFridayDismissed();
  if (dismissed) return null;
  return (
    <div className="rd bf-banner" data-bf="1" data-bf-currency={offer.currency}>
      <a
        className="bf-banner-link"
        href={localeHref(locale, '/pricing')}
        aria-label={blackFridayBarLabel(locale, offer)}
      >
        <BlackFridayDesktopCluster offer={offer} locale={locale} />
        <BlackFridayMobileCluster offer={offer} locale={locale} />
      </a>
      <BlackFridayClose locale={locale} onDismiss={dismiss} />
    </div>
  );
}
