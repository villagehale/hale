import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { FOUNDING_PRICE_DISPLAY, currencyFromIpCountry } from '@hale/types';
import { FoundingJoinForm } from '~/components/billing/founding-join-form';
import { ConnectStage } from '~/components/hale/connect/connect-stage';
import { promoNewVisitorCheckoutEnabled } from '~/lib/billing/flags';
import { foundingPromoOpen } from '~/lib/billing/prices';
import { haleTextsNumber } from '~/lib/channel/connect/hale-texts-href';

export const metadata: Metadata = { title: 'Join as a founding family' };
export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<{ checkout?: string }>;
}

/**
 * Ads new-visitor pay path. Dark unless HOLIDAY_PROMO_ENABLED,
 * PROMO_NEW_VISITOR_CHECKOUT_ENABLED, and the founding window are all on.
 */
export default async function FoundingJoinPage({ searchParams }: PageProps) {
  if (!promoNewVisitorCheckoutEnabled() || !foundingPromoOpen(new Date())) {
    notFound();
  }

  const country = (await headers()).get('x-vercel-ip-country');
  const currency = currencyFromIpCountry(country);
  const { checkout } = await searchParams;

  return (
    <ConnectStage>
      <FoundingJoinForm
        priceLabel={FOUNDING_PRICE_DISPLAY[currency].perYear}
        smsNumber={haleTextsNumber()}
        cancelled={checkout === 'cancelled'}
      />
    </ConnectStage>
  );
}
