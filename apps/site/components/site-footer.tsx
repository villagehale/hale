import { LanguageSelect } from '~/components/language-select';
import { FooterThemeSwitch } from '~/components/landing/v4/theme-switch';
import { LogoMark } from '~/components/logo-mark';
import { localeHref } from '~/i18n/navigation';
import { type Locale, routing } from '~/i18n/routing';
import { getTranslator } from '~/i18n/server';
import { APP_URL } from '~/lib/app-url';

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
 * No "Features" column: the link pointed at the homepage. No social row: the
 * site has no accounts to link, so none are invented.
 *
 * The theme switch and the language selector both live in the brand block —
 * every page ends here, so this is where a reader changes how the site looks and
 * what language it speaks. Every internal link carries the active locale prefix.
 */

export function SiteFooter({ locale = routing.defaultLocale }: { locale?: Locale }) {
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
        { label: t('linkSignIn'), href: `${APP_URL}/sign-in` },
      ],
    },
  ];

  const legal = [
    { label: t('linkPrivacy'), href: localeHref(locale, '/privacy') },
    { label: t('linkTerms'), href: localeHref(locale, '/terms') },
  ];

  return (
    <footer className="border-t border-rule">
      <div className="shell py-12 lg:py-16">
        <div className="flex flex-col justify-between gap-12 lg:flex-row lg:gap-16">
          <div className="lg:max-w-[22rem]">
            <a href={localeHref(locale, '/')} className="flex items-center gap-2.5" aria-label="Hale, home">
              <LogoMark size={28} />
              <span className="font-serif text-[1.2rem] font-semibold leading-none text-spruce" translate="no">
                Hale
              </span>
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
          </div>
        </div>
      </div>
    </footer>
  );
}
