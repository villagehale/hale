import { headers } from 'next/headers';
import type { Locale } from '~/i18n/routing';
import { type HolidayPromo, promoOverrides, resolveHolidayPromo } from './holiday';

type Search = Record<string, string | string[] | undefined>;

/**
 * The holiday promo for this request. English only: the promo copy has no
 * French or Chinese translation yet, so those locales keep the regular page.
 * Outside a request (unit renders) the geo header is absent and CAD is used.
 */
export async function requestHolidayPromo(
  locale: Locale,
  searchParams?: Promise<Search> | Search,
): Promise<HolidayPromo | null> {
  if (locale !== 'en') return null;
  let country: string | null = null;
  try {
    country = (await headers()).get('x-vercel-ip-country');
  } catch {
    country = null;
  }
  const search = searchParams ? await searchParams : undefined;
  return resolveHolidayPromo({ now: new Date(), country, overrides: promoOverrides(search) });
}
