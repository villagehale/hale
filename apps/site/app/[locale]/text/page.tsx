import type { Metadata } from 'next';
import { TextEntry } from '~/components/text-entry';
import { buildAlternates } from '~/i18n/metadata';
import type { Locale } from '~/i18n/routing';
import { getTranslator } from '~/i18n/server';
import { parseSourceCode, readSmsNumber } from '~/lib/text-entry';

/**
 * villagehale.com/text — the QR cards' landing surface (VIL-240 · M5).
 *
 * Dark on purpose: no nav or footer links here, no sitemap entry, and noindex
 * until the number is provisioned and the cards are actually in the world. The
 * only way in is a printed card or a link a founder hands over.
 */

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: Locale }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = getTranslator(locale, 'Text');
  return {
    title: t('metaTitle'),
    description: t('metaDescription'),
    // Overrides the layout's site-wide canonical, which would otherwise point this
    // page at the homepage.
    alternates: buildAlternates(locale, '/text'),
    robots: { index: false, follow: false },
  };
}

export default async function TextEntryPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: Locale }>;
  searchParams: Promise<{ s?: string | string[] }>;
}) {
  const { locale } = await params;
  const { s } = await searchParams;

  return (
    <TextEntry
      source={parseSourceCode(s)}
      smsNumber={readSmsNumber(process.env.NEXT_PUBLIC_HALE_SMS_NUMBER)}
      locale={locale}
    />
  );
}
