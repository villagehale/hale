import type { Metadata } from 'next';
import { RegistrationGuidePage, registrationMetadata } from '~/components/registration-page';
import type { Locale } from '~/i18n/routing';
import { TORONTO_SWIM } from '~/lib/registration/index';

interface PageProps {
  params: Promise<{ locale: Locale }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  return registrationMetadata(TORONTO_SWIM, locale);
}

export default async function TorontoSwimRegistrationPage({ params }: PageProps) {
  const { locale } = await params;
  return <RegistrationGuidePage locale={locale} guide={TORONTO_SWIM} />;
}
