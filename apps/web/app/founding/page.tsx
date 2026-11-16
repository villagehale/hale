import { currencyFromIpCountry } from '@hale/types';
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { FoundingJoinForm } from '~/components/billing/founding-join-form';
import { FreeJoinCard } from '~/components/billing/free-join-card';
import { ConnectStage } from '~/components/hale/connect/connect-stage';
import stage from '~/components/hale/connect/connect.module.css';
import { foundingPriceLabel } from '~/lib/billing/price-display';
import { newVisitorFoundingAllowed } from '~/lib/billing/promo-access';
import { haleTextsNumber } from '~/lib/channel/connect/hale-texts-href';

export const metadata: Metadata = { title: 'Join as a founding family' };
export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: Promise<{ checkout?: string; preview?: string }>;
}

/**
 * Ads new-visitor pay path. Dark unless HOLIDAY_PROMO_ENABLED,
 * PROMO_NEW_VISITOR_CHECKOUT_ENABLED, and the founding window are all on —
 * or `/founding?preview=<PROMO_PREVIEW_TOKEN>` while those flags stay off.
 * Free + founding annual only; monthly / list annual never render here.
 */
export default async function FoundingJoinPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const token = typeof params.preview === 'string' ? params.preview : null;
  if (!newVisitorFoundingAllowed(new Date(), token)) {
    notFound();
  }

  const country = (await headers()).get('x-vercel-ip-country');
  const currency = currencyFromIpCountry(country);
  const checkout = params.checkout;

  return (
    <ConnectStage>
      <div className={stage.pairRow}>
        <FreeJoinCard />
        <FoundingJoinForm
          priceLabel={foundingPriceLabel(currency)}
          currency={currency}
          smsNumber={haleTextsNumber()}
          cancelled={checkout === 'cancelled'}
        />
      </div>
    </ConnectStage>
  );
}
