import { LandingCta } from '~/components/landing-cta';
import { LogoMark } from '~/components/logo-mark';
import { Wordmark } from '~/components/wordmark';
import { localeHref } from '~/i18n/navigation';
import { type Locale, routing } from '~/i18n/routing';
import { getTranslator } from '~/i18n/server';
import { CONTACT_EMAIL, buildSmsHref, readSmsNumber } from '~/lib/text-entry';

/**
 * The marketing header — the v4 liquid-glass nav pill, on every subpage.
 *
 * One design, whole site: this is the same floating glass pill the landing wears
 * inline over its shore hero (components/landing/v4/landing-v4.tsx), so a reader
 * crossing from / to /pricing never changes products. The landing keeps its nav
 * inline because it sits over the hero art; every other page renders this, sticky.
 *
 * The theme control does NOT live here — v4 moved it to the footer switch, which
 * every page ends in. The four pages the site has are reachable from the footer;
 * the bar carries the three that introduce the product plus the one conversion
 * surface the site has, the Text/Email Hale CTA.
 *
 * `scrollTargetId` is the one variation a page may ask for: `sms:` opens nothing
 * on a laptop, so where a page has an on-page CTA block to fall back to, the pill
 * scrolls there instead of firing a dead link. No number provisioned → email,
 * which works everywhere. Every internal link carries the locale prefix.
 */

export function SiteHeader({
  locale = routing.defaultLocale,
  scrollTargetId,
}: {
  locale?: Locale;
  scrollTargetId?: string;
}) {
  const t = getTranslator(locale, 'Header');
  const common = getTranslator(locale, 'Common');
  const smsNumber = readSmsNumber(process.env.NEXT_PUBLIC_HALE_SMS_NUMBER);
  const smsHref = smsNumber ? buildSmsHref(smsNumber, null) : null;

  const nav = [
    { label: t('navPricing'), href: localeHref(locale, '/pricing') },
    { label: t('navFaq'), href: localeHref(locale, '/faq') },
    { label: t('navAbout'), href: localeHref(locale, '/about') },
  ];

  const cta =
    smsHref === null ? (
      <a href={`mailto:${CONTACT_EMAIL}`} className="v4-btn-solid">
        {common('emailHale')}
      </a>
    ) : scrollTargetId !== undefined ? (
      <a href={`#${scrollTargetId}`} className="v4-btn-solid">
        {common('textHale')}
      </a>
    ) : (
      <LandingCta event="cta_text_click" placement="header" href={smsHref} className="v4-btn-solid">
        {common('textHale')}
      </LandingCta>
    );

  return (
    <header className="sticky top-0 z-50 px-4 sm:px-6">
      <nav className="v4-nav v4-glass" aria-label="Primary">
        <a href={localeHref(locale, '/')} className="flex items-center gap-2.5" aria-label="Hale, home">
          <LogoMark size={28} />
          <Wordmark className="text-navy" />
        </a>
        <div className="flex items-center gap-6">
          <div className="v4-navlinks">
            {nav.map((item) => (
              <a key={item.label} href={item.href} className="v4-navlink">
                {item.label}
              </a>
            ))}
          </div>
          {cta}
        </div>
      </nav>
    </header>
  );
}
