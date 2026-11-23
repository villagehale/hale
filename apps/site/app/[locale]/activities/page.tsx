import type { Metadata } from 'next';
import { RedesignActivities } from '~/components/redesign/activities';
import { absolutePageUrl, buildAlternates, ogLocale } from '~/i18n/metadata';
import type { Locale } from '~/i18n/routing';
import { getTranslator } from '~/i18n/server';
import { intakePrefill } from '~/lib/intake-prefill';
import { pageSource } from '~/lib/page-source';
import { shareCardImage } from '~/lib/site/share-cards';
import { readSmsNumber } from '~/lib/text-entry';

interface PageProps {
  params: Promise<{ locale: Locale }>;
  searchParams?: Promise<{ s?: string | string[] }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = getTranslator(locale, 'Activities');
  const title = t('metaTitle');
  const description = t('metaDescription');
  const image = shareCardImage('activities');
  return {
    title,
    description,
    alternates: buildAlternates(locale, '/activities'),
    openGraph: {
      type: 'website',
      title,
      description,
      url: absolutePageUrl(locale, '/activities'),
      siteName: 'Hale',
      locale: ogLocale(locale),
      images: [image],
    },
    twitter: { card: 'summary_large_image', title, description, images: [image] },
  };
}

export default async function ActivitiesHub({ params, searchParams }: PageProps) {
  const { locale } = await params;
  return (
    <RedesignActivities
      locale={locale}
      smsNumber={readSmsNumber(process.env.NEXT_PUBLIC_HALE_SMS_NUMBER)}
      prefill={intakePrefill(locale)}
      source={await pageSource(searchParams)}
    />
  );
}
