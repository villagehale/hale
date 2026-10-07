import { hasLocale } from 'next-intl';
import { notFound } from 'next/navigation';
import { DesignHome } from '~/components/landing/oct-2026/home';
import { LandingV4 } from '~/components/landing/v4/landing-v4';
import { routing } from '~/i18n/routing';
import { readSmsNumber } from '~/lib/text-entry';

/** The homepage keeps shared chrome and reads the provisioned number for its entry links. */
// Legacy translations still render the current Toronto month.
export const dynamic = 'force-dynamic';

export default async function LandingPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  if (locale === 'en') return <DesignHome locale={locale} />;
  return (
    <LandingV4 locale={locale} smsNumber={readSmsNumber(process.env.NEXT_PUBLIC_HALE_SMS_NUMBER)} />
  );
}
