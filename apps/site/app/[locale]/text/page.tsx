import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { TextEntry } from '~/components/text-entry';
import { buildAlternates } from '~/i18n/metadata';
import type { Locale } from '~/i18n/routing';
import { getTranslator } from '~/i18n/server';
import { platformFromUa } from '~/lib/chooser';
import { parseSourceCode, readSmsNumber, readWhatsAppNumber } from '~/lib/text-entry';

/**
 * villagehale.com/text — the chooser (F14): the QR cards' landing surface
 * (VIL-240 · M5), and now the destination of every "Message Hale" CTA on the
 * site. Still noindex and absent from the sitemap: it is a handoff, not a page
 * to rank — the ways in are a printed card, a forwarded link, or the site's own
 * chrome.
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

  // Ordering hint only — the matrix never gates a live mobile channel on it.
  // try/catch because the render-walk tests (cta-wiring, site-chrome) call this
  // page outside request scope, where `headers()` throws; a chooser that cannot
  // read the UA is the `unknown` row, whose QR-first layout works everywhere.
  let ua: string | null = null;
  try {
    ua = (await headers()).get('user-agent');
  } catch {
    ua = null;
  }

  return (
    <TextEntry
      source={parseSourceCode(s)}
      smsNumber={readSmsNumber(process.env.NEXT_PUBLIC_HALE_SMS_NUMBER)}
      whatsappNumber={readWhatsAppNumber(process.env.NEXT_PUBLIC_HALE_WHATSAPP_NUMBER)}
      platform={platformFromUa(ua)}
      locale={locale}
    />
  );
}
