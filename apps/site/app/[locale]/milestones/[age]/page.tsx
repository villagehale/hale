import { permanentRedirect } from 'next/navigation';
import { localeHref } from '~/i18n/navigation';
import type { Locale } from '~/i18n/routing';

/**
 * RETIRED (receipts-room slimdown) — every per-age checkpoint page, retired with its
 * hub. No `generateStaticParams` and no `generateMetadata`: an age that no longer has
 * a page must not be prerendered or advertised, and the redirect covers every slug
 * (including the ones that were never published) rather than only the known list.
 */
export default async function MilestoneAgePage({
  params,
}: {
  params: Promise<{ locale: Locale; age: string }>;
}): Promise<never> {
  const { locale } = await params;
  permanentRedirect(localeHref(locale, '/'));
}
