import type { Metadata } from 'next';
import { RedesignAbout } from '~/components/redesign/about';
import { buildAlternates } from '~/i18n/metadata';
import type { Locale } from '~/i18n/routing';
import { getTranslator } from '~/i18n/server';
import { intakePrefill } from '~/lib/intake-prefill';
import { readSmsNumber } from '~/lib/text-entry';

interface PageProps {
  params: Promise<{ locale: Locale }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = getTranslator(locale, 'About');
  return {
    title: t('metaTitle'),
    description: t('metaDescription'),
    alternates: buildAlternates(locale, '/about'),
  };
}

export default async function AboutPage({ params }: PageProps) {
  const { locale } = await params;
  return (
    <RedesignAbout
      locale={locale}
      smsNumber={readSmsNumber(process.env.NEXT_PUBLIC_HALE_SMS_NUMBER)}
      prefill={intakePrefill(locale)}
    />
  );
}
