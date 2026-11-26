'use client';

import { TextDoor } from '~/components/redesign/text-door';
import type { Locale } from '~/i18n/routing';
import type { BlackFridayOffer } from '~/lib/promo/black-friday';
import type { HolidayPromo } from '~/lib/promo/holiday';
import { BlackFridayCountdown } from './black-friday-banner';
import { PromoStickyReveal } from './promo-sticky';

/**
 * The mobile sticky bar while the price gate is open.
 * Same shell as the season bar. The price line stays after the visitor's
 * Friday ends; the midnight sentence and the clock go away together. The
 * season bar returns when the server stops sending this offer.
 */
export function BlackFridaySticky({
  offer,
  phase,
  locale,
  smsNumber,
  prefill,
  source,
  mode,
}: {
  offer: BlackFridayOffer;
  phase: HolidayPromo['phase'];
  locale: Locale;
  smsNumber: string;
  prefill: string;
  source?: string | null;
  mode: 'chooser' | 'sms';
}) {
  const bits = [
    offer.plus ? `Plus ${offer.plus.banner}` : null,
    offer.max ? `Max ${offer.max.banner}` : null,
  ]
    .filter((bit): bit is string => bit !== null)
    .join(' · ');
  return (
    <PromoStickyReveal phase={phase}>
      <div className="promo-sticky-copy" data-bf-sticky="1">
        <strong>Black Friday</strong>
        <span>{bits}</span>
        <small>
          <BlackFridayCountdown serverNow={offer.serverNow} locale={locale} />
        </small>
      </div>
      <TextDoor
        className="promo-sticky-btn"
        placement="promo_sticky"
        locale={locale}
        smsNumber={smsNumber}
        prefill={prefill}
        mode={mode}
        source={source}
      >
        Text Hale
      </TextDoor>
    </PromoStickyReveal>
  );
}
