import { createTranslator } from 'next-intl';
import en from '../messages/en.json';
import fr from '../messages/fr.json';
import zh from '../messages/zh.json';
import type { Locale } from './routing';

/**
 * The site is Ontario-run and every family's data stays in Canada (hard rule #1),
 * so dates render in Toronto time regardless of where the request is served from.
 */
export const SITE_TIMEZONE = 'America/Toronto';

/**
 * A synchronous, request-scope-free translator for Server Components.
 *
 * We deliberately build on `createTranslator` (the framework-agnostic primitive)
 * rather than the request-scoped `getTranslations`: the marketing pages render
 * from static message bundles keyed by the `[locale]` URL segment, and this form
 * works identically in the real RSC render and in `renderToStaticMarkup` unit
 * tests — `getTranslations` is a React-server-only API and throws outside a Next
 * request. Client Components receive their few strings as props.
 */
type Messages = typeof en;

const MESSAGES: Record<Locale, Messages> = {
  en,
  fr: fr as Messages,
  zh: zh as Messages,
};

export function getMessages(locale: Locale): Messages {
  return MESSAGES[locale];
}

/**
 * A date-only ISO string (`2026-07-31`) as a Date anchored at noon UTC, so the
 * calendar day survives formatting in {@link SITE_TIMEZONE} rather than slipping a
 * day at a negative offset. For the locale-formatted "last reviewed / updated"
 * lines (`{date, date, long}`).
 */
export function isoToDate(iso: string): Date {
  return new Date(`${iso}T12:00:00Z`);
}

export function getTranslator<Namespace extends keyof Messages>(locale: Locale, namespace: Namespace) {
  return createTranslator({
    locale,
    messages: MESSAGES[locale],
    namespace,
    timeZone: SITE_TIMEZONE,
  });
}
