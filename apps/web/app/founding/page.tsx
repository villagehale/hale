import { currencyFromIpCountry, serverCheckoutCurrency } from '@hale/types';
import type { Metadata } from 'next';
import { cookies, headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { FoundingJoinForm } from '~/components/billing/founding-join-form';
import { FreeJoinCard } from '~/components/billing/free-join-card';
import { ConnectStage } from '~/components/hale/connect/connect-stage';
import stage from '~/components/hale/connect/connect.module.css';
import { checkoutServerCurrencyEnabled } from '~/lib/billing/flags';
import { promoPriceLabel } from '~/lib/billing/price-display';
import { newVisitorFoundingAllowed } from '~/lib/billing/promo-access';
import {
  PROMO_PREVIEW_COOKIE,
  PROMO_PREVIEW_COOKIE_TTL_SECONDS,
  promoPreviewTokenMatches,
  signPromoPreviewCookie,
} from '~/lib/billing/promo-preview';
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
 * Free + Plus/Max annual promo; monthly / list annual never render here.
 */
export default async function FoundingJoinPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const token = typeof params.preview === 'string' ? params.preview : null;
  const jar = await cookies();
  const previewCookie = jar.get(PROMO_PREVIEW_COOKIE)?.value ?? null;
  if (promoPreviewTokenMatches(token)) {
    const signed = signPromoPreviewCookie();
    if (signed) {
      jar.set(PROMO_PREVIEW_COOKIE, signed, {
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        path: '/',
        maxAge: PROMO_PREVIEW_COOKIE_TTL_SECONDS,
      });
    }
  }
  if (!newVisitorFoundingAllowed(new Date(), token, process.env, previewCookie)) {
    notFound();
  }

  const country = (await headers()).get('x-vercel-ip-country');
  const currency = checkoutServerCurrencyEnabled()
    ? serverCheckoutCurrency(country)
    : currencyFromIpCountry(country);
  if (!currency) notFound();
  const checkout = params.checkout;

  return (
    <ConnectStage>
      <div className={stage.pairRow}>
        <FreeJoinCard />
        <FoundingJoinForm
          plusLabel={promoPriceLabel('plus', currency)}
          maxLabel={promoPriceLabel('family', currency)}
          smsNumber={haleTextsNumber()}
          cancelled={checkout === 'cancelled'}
        />
      </div>
    </ConnectStage>
  );
}
