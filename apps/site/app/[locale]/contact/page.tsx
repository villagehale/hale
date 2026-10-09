import type { Metadata } from 'next';
import { RedesignContact } from '~/components/redesign/contact';
import { buildAlternates, socialMetadata } from '~/i18n/metadata';
import type { Locale } from '~/i18n/routing';
import { getTranslator } from '~/i18n/server';
import { intakePrefill } from '~/lib/intake-prefill';
import { pageSource } from '~/lib/page-source';
import { readSmsNumber } from '~/lib/text-entry';

interface PageProps {
  params: Promise<{ locale: Locale }>;
  searchParams?: Promise<{ s?: string | string[] }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = getTranslator(locale, 'Contact');
  const title = t('metaTitle');
  const description = t('metaDescription');
  return {
    title,
    description,
    alternates: buildAlternates(locale, '/contact'),
    ...socialMetadata(locale, '/contact', title, description),
  };
}

export default async function ContactPage({ params, searchParams }: PageProps) {
  const { locale } = await params;
  return (
    <RedesignContact
      locale={locale}
      smsNumber={readSmsNumber(process.env.NEXT_PUBLIC_HALE_SMS_NUMBER)}
      prefill={intakePrefill(locale)}
      source={await pageSource(searchParams)}
    />
  );
}
