import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { Locale } from '~/i18n/routing';
import { notFoundMetadata } from '~/lib/site/not-found-copy';
import { shareQueryForRequest } from '~/lib/site/share-cards';

/**
 * Unknown paths under a locale. next-intl only renders `not-found.tsx` when a
 * route calls `notFound()`; without this catch-all, `/no-such-page` never
 * reaches it. The site has no root `app/layout.tsx`, so the localized
 * not-found is the 404.
 */
export async function generateMetadata({
  params,
  searchParams,
}: {
  params: Promise<{ locale: Locale }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}): Promise<Metadata> {
  const { locale } = await params;
  return notFoundMetadata(locale, await shareQueryForRequest(locale, await searchParams));
}

export default function UnknownPage() {
  notFound();
}
