import { permanentRedirect } from 'next/navigation';
import { localeHref } from '~/i18n/navigation';
import type { Locale } from '~/i18n/routing';

/**
 * RETIRED (receipts-room slimdown). The milestones hub was old-positioning reference
 * content — a CDC-checkpoint library, which is what a parent already gets from a
 * search engine. Hale's pitch is not "read about milestones", it is "text a number and
 * the thing gets done", so the hub sent readers to the wrong promise. The checkpoint
 * data (lib/milestones) is untouched; only the public pages are gone. The redirect
 * keeps the reader in their language.
 */
export default async function MilestonesPage({
  params,
}: {
  params: Promise<{ locale: Locale }>;
}): Promise<never> {
  const { locale } = await params;
  permanentRedirect(localeHref(locale, '/'));
}
