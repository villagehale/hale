'use client';

import { blackFridayCountdownLabel } from '@hale/types';
import { TextDoor } from '~/components/redesign/text-door';
import type { Locale } from '~/i18n/routing';
import type { BlackFridayOffer } from '~/lib/promo/black-friday';
import { blackFridayEndsPrefix } from '~/lib/promo/black-friday';
import type { HolidayPromo } from '~/lib/promo/holiday';
import { BlackFridayCountdown, useBlackFridayRemaining } from './black-friday-banner';
import { PromoStickyReveal } from './promo-sticky';

/**
 * The mobile sticky bar during the one-day window.
 * Same shell as the season bar. The copy is the BF price for this region
 * and the live countdown. At zero the bar unmounts.
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
  const remaining = useBlackFridayRemaining(offer.endsAt, offer.serverNow);
  if (blackFridayCountdownLabel(remaining) === null) return null;
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
          <BlackFridayCountdown
            endsAt={offer.endsAt}
            serverNow={offer.serverNow}
            prefix={blackFridayEndsPrefix(locale)}
          />
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
