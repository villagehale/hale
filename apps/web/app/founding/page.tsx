import {
  CHECKOUT_REGION_UNSUPPORTED_MESSAGE,
  currencyFromIpCountry,
  serverCheckoutCurrency,
} from '@hale/types';
import type { Metadata } from 'next';
import { cookies, headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { auth } from '~/auth';
import { FoundingJoinForm } from '~/components/billing/founding-join-form';
import { FreeJoinCard } from '~/components/billing/free-join-card';
import { ConnectStage } from '~/components/hale/connect/connect-stage';
import stage from '~/components/hale/connect/connect.module.css';
import { authConfigured } from '~/lib/auth-config';
import { checkoutServerCurrencyEnabled } from '~/lib/billing/flags';
import { promoPriceLabel } from '~/lib/billing/price-display';
import { newVisitorFoundingAllowed } from '~/lib/billing/promo-access';
import {
  PROMO_PREVIEW_COOKIE,
  PROMO_PREVIEW_COOKIE_TTL_SECONDS,
  promoPreviewTokenMatches,
  readPromoPreviewCookie,
  signPromoPreviewCookie,
} from '~/lib/billing/promo-preview';
import { haleTextsNumber } from '~/lib/channel/connect/hale-texts-href';

export const metadata: Metadata = { title: { absolute: 'Join Hale' } };
export const dynamic = 'force-dynamic';

type FoundingSearch = Record<string, string | string[] | undefined>;

interface PageProps {
  searchParams: Promise<FoundingSearch>;
}

/** Signed-in checkout, keeping attribution and a Stripe cancel. Never the preview secret. */
export function settingsFoundingHref(search: FoundingSearch): string {
  const qs = new URLSearchParams();
  for (const [key, raw] of Object.entries(search)) {
    if (key === 'preview') continue;
    const value = (Array.isArray(raw) ? raw[0] : raw)?.trim();
    if (value) qs.set(key, value);
  }
  const encoded = qs.toString();
  return encoded ? `/settings/founding?${encoded}` : '/settings/founding';
}

/**
 * Ads new-visitor pay path. Dark unless HOLIDAY_PROMO_ENABLED,
 * PROMO_NEW_VISITOR_CHECKOUT_ENABLED, and the founding window are all on —
 * or `/founding?preview=<PROMO_PREVIEW_TOKEN>` while those flags stay off.
 * Free + Plus/Max annual promo; monthly / list annual never render here.
 * This page does not read `plan`: after the code the parent chooses Plus or Max.
 * A signed-in family is sent to the signed-in checkout so they can still pay.
 * A matching preview token or cookie stays here — that door is the new-visitor
 * proof while the live flags are off.
 */
export default async function FoundingJoinPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const token = typeof params.preview === 'string' ? params.preview : null;
  const jar = await cookies();
  const previewCookie = jar.get(PROMO_PREVIEW_COOKIE)?.value ?? null;
  const previewUnlock = promoPreviewTokenMatches(token) || readPromoPreviewCookie(previewCookie);
  if (authConfigured() && !previewUnlock) {
    const session = await auth();
    if (session?.user?.id) redirect(settingsFoundingHref(params));
  }
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
  if (!currency) {
    return (
      <ConnectStage>
        <p className={stage.pairRow}>{CHECKOUT_REGION_UNSUPPORTED_MESSAGE}</p>
      </ConnectStage>
    );
  }
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
