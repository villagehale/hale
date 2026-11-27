'use client';

import { localeHref } from '~/i18n/navigation';
import type { Locale } from '~/i18n/routing';
import type { BlackFridayOffer } from '~/lib/promo/black-friday';
import {
  blackFridayEndsLine,
  blackFridaySeePrices,
  blackFridayShortPriceLine,
} from '~/lib/promo/black-friday';
import { bfInter, bfMono, heroBrush } from '~/lib/site/display-fonts';
import { BlackFridayClock, BlackFridayClose, useBlackFridayDismissed } from './black-friday-banner';
import { PromoStickyReveal } from './promo-sticky';

/**
 * The mobile sticky while the price gate is open.
 * One centered row: sticker, today's price, the midnight line, the clock, See prices.
 * The season bar returns when the server stops sending this offer.
 */
export function BlackFridaySticky({ offer, locale }: { offer: BlackFridayOffer; locale: Locale }) {
  const { dismissed, dismiss } = useBlackFridayDismissed();
  if (dismissed) return null;
  return (
    <PromoStickyReveal phase="black_friday" className="bf-sticky">
      <span className="bf-sticky-lead">
        <span className={`bf-sticker ${heroBrush.className}`}>Black Friday</span>
        <span className={`bf-prices ${bfInter.className}`}>{blackFridayShortPriceLine(locale, offer)}</span>
        <span className={`bf-ends ${bfMono.className}`}>{blackFridayEndsLine(locale)}</span>
      </span>
      <BlackFridayClock serverNow={offer.serverNow} locale={locale} />
      <a className={`bf-see ${bfInter.className}`} href={localeHref(locale, '/pricing')}>
        {blackFridaySeePrices(locale)}
      </a>
      <BlackFridayClose locale={locale} onDismiss={dismiss} />
    </PromoStickyReveal>
  );
}
