import { RedesignHome } from '~/components/redesign/home';
import type { Locale } from '~/i18n/routing';
import { sitePriceSurface } from '~/lib/billing/site-price-surface';
import { visitorCurrency } from '~/lib/billing/visitor-currency';
import { intakePrefill } from '~/lib/intake-prefill';
import { pageSource } from '~/lib/page-source';
import { siteJsonLd } from '~/lib/site/structured-data';
import { readSmsNumber } from '~/lib/text-entry';
import { requestHolidayPromo } from '~/lib/promo/server';

/**
 * villagehale.com. One landing, in every language — the redesigned shore.
 * With no number provisioned the page degrades to email rather than rendering a
 * dead `sms:` link, so the read has to happen here and be handed down. The
 * homepage's metadata (title, description, hreflang) is the localized layout's.
 *
 * Dynamic so HOLIDAY_PROMO_ENABLED and the exclusive founding cutoff are read
 * at request time (the locale layout is otherwise statically generated).
 */
export const dynamic = 'force-dynamic';

export default async function LandingPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: Locale }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  const smsNumber = readSmsNumber(process.env.NEXT_PUBLIC_HALE_SMS_NUMBER);
  const source = await pageSource(searchParams);
  const promo = await requestHolidayPromo(locale, searchParams);
  const priceSurface = sitePriceSurface();
  const currency = priceSurface === 'list' ? await visitorCurrency() : 'CAD';
  return (
    <>
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON-LD is a serialized in-repo data object (no user input).
        dangerouslySetInnerHTML={{ __html: JSON.stringify(siteJsonLd(locale)) }}
      />
      <RedesignHome
        locale={locale}
        smsNumber={smsNumber}
        prefill={intakePrefill(locale)}
        source={source}
        promo={promo}
        priceSurface={priceSurface}
        currency={currency}
      />
    </>
  );
}
