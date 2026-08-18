'use client';

import { Languages } from 'lucide-react';
import { LOCALE_NAMES, localeHref, stripLocalePrefix } from '~/i18n/navigation';
import { type Locale, routing } from '~/i18n/routing';

/**
 * The footer language selector, beside the theme switch. It switches locale while
 * preserving the page the reader is on: the current path is read live from
 * `window.location` at change time and re-prefixed for the chosen language, so
 * `/fr/pricing` → `/pricing` (English) or `/zh/pricing`.
 *
 * Deliberately provider-free — it reads no next-intl client context and no router
 * hook, so it renders in a bare `renderToStaticMarkup` (the chrome tests) as
 * plainly as in the app. The full reload matches the site's other links, which
 * are all plain `<a>`.
 */
export function LanguageSelect({ locale, label }: { locale: Locale; label: string }) {
  return (
    <label className="inline-flex items-center gap-2 text-slate-green">
      <Languages size={15} aria-hidden="true" className="shrink-0" />
      <span className="sr-only">{label}</span>
      <select
        aria-label={label}
        defaultValue={locale}
        onChange={(event) => {
          const base = stripLocalePrefix(window.location.pathname);
          window.location.href = localeHref(event.target.value as Locale, base);
        }}
        className="cursor-pointer rounded-full border border-rule bg-transparent py-1.5 pl-3 pr-2 text-[13px] text-slate-green transition-colors hover:text-spruce"
      >
        {routing.locales.map((l) => (
          <option key={l} value={l} translate="no">
            {LOCALE_NAMES[l]}
          </option>
        ))}
      </select>
    </label>
  );
}
