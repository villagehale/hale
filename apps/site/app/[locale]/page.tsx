import { RedesignHome } from '~/components/redesign/home';
import type { Locale } from '~/i18n/routing';
import { intakePrefill } from '~/lib/intake-prefill';
import { pageSource } from '~/lib/page-source';
import { siteJsonLd } from '~/lib/site/structured-data';
import { readSmsNumber } from '~/lib/text-entry';

/**
 * villagehale.com. One landing, in every language — the redesigned shore.
 * With no number provisioned the page degrades to email rather than rendering a
 * dead `sms:` link, so the read has to happen here and be handed down. The
 * homepage's metadata (title, description, hreflang) is the localized layout's.
 */
export default async function LandingPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: Locale }>;
  searchParams?: Promise<{ s?: string | string[] }>;
}) {
  const { locale } = await params;
  const smsNumber = readSmsNumber(process.env.NEXT_PUBLIC_HALE_SMS_NUMBER);
  const source = await pageSource(searchParams);
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
      />
    </>
  );
}
