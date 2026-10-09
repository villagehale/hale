import { permanentRedirect } from 'next/navigation';
import { localeHref } from '~/i18n/navigation';
import type { Locale } from '~/i18n/routing';

/**
 * Retired. Hale is written to parents. A centre question that families still ask
 * ("Is Hale official?") lives on /faq. The old URL keeps the reader in their language.
 */
export default async function ForCentresPage({
  params,
}: {
  params: Promise<{ locale: Locale }>;
}): Promise<never> {
  const { locale } = await params;
  permanentRedirect(localeHref(locale, '/'));
}
