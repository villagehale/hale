import type { Metadata } from 'next';
import { RedesignText } from '~/components/redesign/text';
import { buildAlternates } from '~/i18n/metadata';
import type { Locale } from '~/i18n/routing';
import { getTranslator } from '~/i18n/server';
import { intakePrefill } from '~/lib/intake-prefill';
import { parseSourceCode, readSmsNumber } from '~/lib/text-entry';

/**
 * villagehale.com/text — the QR cards' landing surface, and the destination of
 * the site's "Text Hale" CTAs. Still noindex and absent from the sitemap: it is
 * a handoff, not a page to rank.
 *
 * Dynamic because the number, the composer prefill, and a `?s=` on this URL
 * are request-time. The QR is painted on the server, so the code has to be in
 * the body before first paint. The redesign does not read the user-agent;
 * every locale renders the same door.
 */
export const dynamic = 'force-dynamic';

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
    alternates: buildAlternates(locale, '/text'),
    robots: { index: false, follow: false },
  };
}

export default async function TextEntryPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: Locale }>;
  searchParams?: Promise<{ s?: string | string[] }>;
}) {
  const { locale } = await params;
  // Same validator the header pill's first-touch reader uses. Absent, repeated,
  // or not a source code → null, and the door stays the bare hello.
  const source = parseSourceCode((await searchParams)?.s);
  return (
    <RedesignText
      locale={locale}
      smsNumber={readSmsNumber(process.env.NEXT_PUBLIC_HALE_SMS_NUMBER)}
      prefill={intakePrefill(locale)}
      source={source}
    />
  );
}
