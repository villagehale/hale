import { permanentRedirect } from 'next/navigation';
import { localeHref } from '~/i18n/navigation';
import type { Locale } from '~/i18n/routing';

/**
 * Retired. The dated city registration guides are gone; the activities hub is
 * the page that remains. Each old URL keeps the reader in their language.
 */
export default async function TorontoFallRecreationRegistrationPage({
  params,
}: {
  params: Promise<{ locale: Locale }>;
}): Promise<never> {
  const { locale } = await params;
  permanentRedirect(localeHref(locale, '/activities'));
}
