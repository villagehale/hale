import { LandingV5 } from '~/components/landing/v5/landing-v5';
import type { Locale } from '~/i18n/routing';
import { readSmsNumber } from '~/lib/text-entry';

/**
 * villagehale.com. One landing, unconditionally — the loop on its spine (v5).
 * The liquid-glass shore it replaced is retired as the live page; the flag
 * matrix that carried the pivot is long gone, and a landing page is the one
 * surface a flag cannot make honest: two landings alive at once is how copy
 * drifts, so a claim that is not yet true comes OFF the page rather than behind
 * an env var.
 *
 * With no number provisioned the page degrades to email rather than rendering a
 * dead `sms:` link, so the read has to happen here and be handed down. The
 * homepage's metadata (title, description, hreflang) is the localized layout's.
 */
export default async function LandingPage({ params }: { params: Promise<{ locale: Locale }> }) {
  const { locale } = await params;
  return (
    <LandingV5 locale={locale} smsNumber={readSmsNumber(process.env.NEXT_PUBLIC_HALE_SMS_NUMBER)} />
  );
}
