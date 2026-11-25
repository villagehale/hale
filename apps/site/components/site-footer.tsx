import { CookieSettingsButton } from '~/components/cookie-settings-button';
import { FooterThemeSwitch } from '~/components/landing/v4/theme-switch';
import { LanguageSelect } from '~/components/language-select';
import { LogoMark } from '~/components/logo-mark';
import { Wordmark } from '~/components/wordmark';
import { localeHref } from '~/i18n/navigation';
import { type Locale, routing } from '~/i18n/routing';
import { getTranslator } from '~/i18n/server';
import { APP_URL } from '~/lib/app-url';
import { HALE_SOCIAL } from '~/lib/site/social';

/**
 * The marketing footer — ONE foot, on the homepage and on every subpage.
 *
 * The landing's foot said the name out loud and named the company; the subpages'
 * carried the real navigation. This is both: the brand block on the left with
 * the pronunciation and the Canadian company line, the two link columns beside
 * it, and the legal pair in the bottom bar. Legal lives ONLY in that bar — a
 * Legal column would duplicate it — and points at this site's own policy pages,
 * since D20 moved them here and the app's old routes permanently redirect back.
 *
 * No "Features" column: the link pointed at the homepage.
 *
 * The theme switch, the language selector, and Hale's profiles sit in one row
 * of the brand block — every page ends here, so this is where a reader changes
 * how the site looks, what language it speaks, and where else Hale is. Every
 * internal link carries the active locale prefix.
 *
 * `omitPrivacyLink` is the /text exception only. That page already links the
 * policy once, on the Canada line in the column. The bar's "Privacy policy"
 * would be a second link to the same page, which Design rejected. Every other
 * page keeps the legal pair.
 */

function SocialIcon({ id }: { id: (typeof HALE_SOCIAL)[number]['id'] }) {
  if (id === 'x') {
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.744l7.725-8.835L1.254 2.25H8.08l4.253 5.622L18.244 2.25zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
      </svg>
    );
  }
  if (id === 'instagram') {
    return (
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        aria-hidden="true"
      >
        <rect x="3" y="3" width="18" height="18" rx="5" />
        <circle cx="12" cy="12" r="4" />
        <circle cx="17.5" cy="6.5" r="1" fill="currentColor" stroke="none" />
      </svg>
    );
  }
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M4.98 3.5C4.98 4.88 3.88 6 2.5 6S0 4.88 0 3.5 1.12 1 2.5 1s2.48 1.12 2.48 2.5zM.5 8.5h4V24h-4V8.5zM8.5 8.5h3.8v2.1h.1c.5-1 1.8-2.1 3.8-2.1 4 0 4.8 2.6 4.8 6V24h-4v-7.7c0-1.8 0-4.1-2.5-4.1s-2.9 2-2.9 4V24h-4V8.5z" />
    </svg>
  );
}

export function SiteFooter({
  locale = routing.defaultLocale,
  omitPrivacyLink = false,
}: {
  locale?: Locale;
  omitPrivacyLink?: boolean;
}) {
  const t = getTranslator(locale, 'Footer');
  const theme = getTranslator(locale, 'ThemeSwitch');
  const lang = getTranslator(locale, 'LanguageSwitcher');

  const columns = [
    {
      heading: t('productHeading'),
      links: [
        { label: t('linkPricing'), href: localeHref(locale, '/pricing') },
        { label: t('linkFaq'), href: localeHref(locale, '/faq') },
        { label: t('linkActivities'), href: localeHref(locale, '/activities') },
      ],
    },
    {
      heading: t('resourcesHeading'),
      links: [
        { label: t('linkGuides'), href: localeHref(locale, '/answers') },
        { label: t('linkAbout'), href: localeHref(locale, '/about') },
        { label: t('linkContact'), href: localeHref(locale, '/contact') },
      ],
    },
  ];

  const legal = [
    ...(omitPrivacyLink
      ? []
      : [{ label: t('linkPrivacy'), href: localeHref(locale, '/privacy') }]),
    { label: t('linkTerms'), href: localeHref(locale, '/terms') },
  ];
  // Sign-in stays last. Cookie settings sits between Terms and Sign in.
  const signIn = { label: t('signIn'), href: `${APP_URL}/sign-in` };

  return (
    <footer className="border-t border-rule">
      <div className="shell py-12 lg:py-16">
        <div className="flex flex-col justify-between gap-12 lg:flex-row lg:gap-16">
          <div className="lg:max-w-[22rem]">
            <a
              href={localeHref(locale, '/')}
              className="flex items-center gap-2.5"
              aria-label="Hale, home"
            >
              <LogoMark size={28} />
              <Wordmark className="text-spruce" />
            </a>
            <p className="mt-5 text-[13px] leading-[1.6] text-slate-green">{t('blurb')}</p>
            {/* The name, said out loud. It carries the whole brand — Hawaiian for
                home, a honu for a mark, aloha@ for an address. */}
            <p className="mt-4 text-[12px] leading-[1.6] text-slate-green">
              <span translate="no">{t('pronunciationPrefix')}</span>{' '}
              <span className="font-mono" translate="no">
                {t('pronunciation')}
              </span>{' '}
              {t('pronunciationSuffix')}
            </p>
            <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-4">
              <FooterThemeSwitch
                labels={{
                  light: theme('light'),
                  dark: theme('dark'),
                  toLight: theme('toLight'),
                  toDark: theme('toDark'),
                }}
              />
              <LanguageSelect locale={locale} label={lang('label')} />
              <div className="flex items-center gap-3">
                {HALE_SOCIAL.map((profile) => (
                  <a
                    key={profile.id}
                    href={profile.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={t(profile.label)}
                    className="text-slate-green transition-colors hover:text-spruce"
                  >
                    <SocialIcon id={profile.id} />
                  </a>
                ))}
              </div>
            </div>
          </div>

          <nav aria-label="Footer" className="grid grid-cols-2 gap-8 md:gap-12 lg:w-[38%]">
            {columns.map((column) => (
              <div key={column.heading}>
                <h2 className="mb-5 text-[14px] font-semibold text-spruce">{column.heading}</h2>
                <ul className="flex flex-col gap-3.5">
                  {column.links.map((item) => (
                    <li key={item.label}>
                      <a
                        href={item.href}
                        className="text-[13px] text-slate-green transition-colors hover:text-spruce"
                      >
                        {item.label}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>
        </div>

        <hr className="mb-6 mt-12 border-hair" />

        <div className="flex flex-col-reverse items-start justify-between gap-4 md:flex-row md:items-center">
          <div className="text-[13px] leading-[1.6] text-slate-green">
            <p>{t('copyright', { year: String(new Date().getFullYear()) })}</p>
            <p className="mt-1">{t('company')}</p>
          </div>
          <div className="flex flex-wrap gap-6">
            {legal.map((item) => (
              <a
                key={item.label}
                href={item.href}
                className="text-[13px] text-slate-green underline decoration-rule underline-offset-[4px] transition-colors hover:text-spruce hover:decoration-current"
              >
                {item.label}
              </a>
            ))}
            <CookieSettingsButton label={t('cookieSettings')} />
            <a
              href={signIn.href}
              className="text-[13px] text-slate-green underline decoration-rule underline-offset-[4px] transition-colors hover:text-spruce hover:decoration-current"
            >
              {signIn.label}
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
}
