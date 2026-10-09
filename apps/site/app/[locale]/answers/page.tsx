import type { Metadata } from 'next';
import { RedesignAnswers } from '~/components/redesign/answers';
import { buildAlternates } from '~/i18n/metadata';
import type { Locale } from '~/i18n/routing';
import { getTranslator } from '~/i18n/server';
import { publishedAnswers } from '~/lib/answers/index';
import { intakePrefill } from '~/lib/intake-prefill';
import { pageSource } from '~/lib/page-source';
import { readSmsNumber } from '~/lib/text-entry';

interface PageProps {
  params: Promise<{ locale: Locale }>;
  searchParams?: Promise<{ s?: string | string[] }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = getTranslator(locale, 'Answers');
  return {
    title: t('metaTitle'),
    description: t('metaDescription'),
    alternates: buildAlternates(locale, '/answers'),
    robots: publishedAnswers.length > 0 ? undefined : { index: false, follow: true },
  };
}

export default async function AnswersIndexPage({ params, searchParams }: PageProps) {
  const { locale } = await params;
  return (
    <RedesignAnswers
      locale={locale}
      smsNumber={readSmsNumber(process.env.NEXT_PUBLIC_HALE_SMS_NUMBER)}
      prefill={intakePrefill(locale)}
      source={await pageSource(searchParams)}
    />
  );
}
