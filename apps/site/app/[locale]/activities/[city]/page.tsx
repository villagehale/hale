import { notFound, permanentRedirect } from 'next/navigation';
import { localeHref } from '~/i18n/navigation';
import type { Locale } from '~/i18n/routing';

/**
 * Retired. The city guides are gone; the activities hub is the page that remains.
 * Each old URL keeps the reader in their language.
 */
export const RETIRED_CITY_SLUGS = [
  'toronto',
  'ottawa',
  'vancouver',
  'calgary',
  'montreal',
] as const;

interface PageProps {
  params: Promise<{ locale: Locale; city: string }>;
}

export function generateStaticParams(): { city: string }[] {
  return RETIRED_CITY_SLUGS.map((city) => ({ city }));
}

export default async function ActivityCityRedirect({ params }: PageProps): Promise<never> {
  const { locale, city } = await params;
  if (!RETIRED_CITY_SLUGS.includes(city as (typeof RETIRED_CITY_SLUGS)[number])) notFound();
  permanentRedirect(localeHref(locale, '/activities'));
}
