import { LandingV4 } from '~/components/landing/v4/landing-v4';
import type { Locale } from '~/i18n/routing';
import { readSmsNumber } from '~/lib/text-entry';

/**
 * villagehale.com. One landing: a short hero on the shore, four product lines,
 * the live pricing cards, and a short FAQ.
 *
 * With no number provisioned the page degrades to email rather than rendering a
 * dead `sms:` link, so the read has to happen here and be handed down. The
 * homepage's metadata (title, description, hreflang) is the localized layout's.
 */
export default async function LandingPage({ params }: { params: Promise<{ locale: Locale }> }) {
  const { locale } = await params;
  return (
    <LandingV4 locale={locale} smsNumber={readSmsNumber(process.env.NEXT_PUBLIC_HALE_SMS_NUMBER)} />
  );
}
