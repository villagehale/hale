import { headers } from 'next/headers';
import { SiteFooter } from '~/components/site-footer';
import { SiteHeader } from '~/components/site-header';
import type { Locale } from '~/i18n/routing';
import {
  LOCALE_HEADER,
  localeFromHeader,
  notFoundHeading,
  notFoundMetadata,
} from '~/lib/site/not-found-copy';
import { shareQueryForRequest } from '~/lib/site/share-cards';

/**
 * Localized 404. The title comes from metadata only — an inline `<title>`
 * would sit beside it and the page would have two.
 */
export async function generateMetadata(props?: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const locale = await requestLocale();
  const search = props?.searchParams ? await props.searchParams : undefined;
  return notFoundMetadata(locale, await shareQueryForRequest(locale, search));
}

export function NotFoundView({ locale }: { locale: Locale }) {
  return (
    <>
      <SiteHeader locale={locale} />
      <div className="rd">
        <main id="main" className="sp-hero">
          <h1 className="sp-h1">{notFoundHeading(locale)}</h1>
        </main>
      </div>
      <SiteFooter locale={locale} />
    </>
  );
}

export default async function NotFound() {
  return <NotFoundView locale={await requestLocale()} />;
}

async function requestLocale(): Promise<Locale> {
  const headerStore = await headers();
  return localeFromHeader(headerStore.get(LOCALE_HEADER));
}
