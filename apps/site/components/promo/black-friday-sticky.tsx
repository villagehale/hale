'use client';

import { localeHref } from '~/i18n/navigation';
import type { Locale } from '~/i18n/routing';
import type { BlackFridayOffer } from '~/lib/promo/black-friday';
import { blackFridayBarLabel } from '~/lib/promo/black-friday';
import {
  BlackFridayClose,
  BlackFridayMobileCluster,
  useBlackFridayDismissed,
} from './black-friday-banner';
import { PromoStickyReveal } from './promo-sticky';

/**
 * The mobile sticky while the price gate is open.
 * The same one-row cluster as the mobile top bar, inside the floating card.
 * The whole card links to pricing. The close badge is a sibling of that link.
 */
export function BlackFridaySticky({ offer, locale }: { offer: BlackFridayOffer; locale: Locale }) {
  const { dismissed, dismiss } = useBlackFridayDismissed();
  if (dismissed) return null;
  return (
    <PromoStickyReveal phase="black_friday" className="bf-sticky">
      <a
        className="bf-sticky-link"
        href={localeHref(locale, '/pricing')}
        aria-label={blackFridayBarLabel(locale, offer)}
      >
        <BlackFridayMobileCluster offer={offer} locale={locale} />
      </a>
      <BlackFridayClose locale={locale} onDismiss={dismiss} />
    </PromoStickyReveal>
  );
}
