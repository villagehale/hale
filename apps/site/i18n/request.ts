import { hasLocale } from 'next-intl';
import { getRequestConfig } from 'next-intl/server';
import { routing } from './routing';
import { SITE_TIMEZONE } from './server';

/**
 * Server-side i18n config. The `[locale]` segment feeds `requestLocale`; anything
 * unrecognised falls back to English rather than 404-ing the request config.
 * Messages are the flat per-locale JSON bundles under `messages/`.
 *
 * A default `timeZone` is pinned so server- and client-formatted dates agree
 * (the company is Ontario-based and all data stays in Canada — hard rule #1).
 */
export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale;
  const locale = hasLocale(routing.locales, requested) ? requested : routing.defaultLocale;

  return {
    locale,
    timeZone: SITE_TIMEZONE,
    messages: (await import(`../messages/${locale}.json`)).default,
  };
});
