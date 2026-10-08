import { permanentRedirect } from 'next/navigation';
import { localeHref } from '~/i18n/navigation';
import type { Locale } from '~/i18n/routing';

/** Retired. See the Toronto fall guide: these URLs 308 to the activities hub. */
export default async function TorontoSwimRegistrationPage({
  params,
}: {
  params: Promise<{ locale: Locale }>;
}): Promise<never> {
  const { locale } = await params;
  permanentRedirect(localeHref(locale, '/activities'));
}
