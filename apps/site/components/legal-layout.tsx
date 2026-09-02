import type { ReactNode } from 'react';
import { LogoMark } from '~/components/logo-mark';
import { Wordmark } from '~/components/wordmark';
import { localeHref } from '~/i18n/navigation';
import type { Locale } from '~/i18n/routing';
import { getTranslator, isoToDate } from '~/i18n/server';

/**
 * The long-form shell for /terms and /privacy on the marketing domain
 * (VIL-250 · M14 · B-legal): the brand line, a reading column, an in-page table
 * of contents that becomes a sticky sidebar on desktop, the not-legal-advice
 * note, and the cross-link to the other policy. Pages own only their copy.
 *
 * Deliberately without the site header and footer. The policies are a
 * destination a parent arrives at from a text message or an email footer, not a
 * step in a funnel — and the marketing chrome would pull them back into one.
 *
 * The shell chrome (the "Legal" eyebrow, the last-updated line, the
 * not-legal-advice note, the table-of-contents heading, the cross-link lead-in)
 * is localized; the policy title, sections, and body are supplied by the page and
 * remain in English until a professional legal translation lands.
 */

export interface LegalSection {
  id: string;
  title: string;
}

export function LegalLayout({
  locale,
  title,
  lastUpdatedIso,
  intro,
  sections,
  children,
  crossLinkHref,
  crossLinkLabel,
}: {
  locale: Locale;
  title: string;
  lastUpdatedIso: string;
  intro: ReactNode;
  sections: LegalSection[];
  children: ReactNode;
  crossLinkHref: string;
  crossLinkLabel: string;
}) {
  const t = getTranslator(locale, 'Legal');

  return (
    <main id="main" tabIndex={-1}>
      <header className="shell legal-print-hide flex items-center justify-between py-6">
        <a href={localeHref(locale, '/')} className="flex items-center gap-2.5" aria-label="Hale, home">
          <LogoMark size={28} />
          <Wordmark className="text-spruce" />
        </a>
      </header>

      <section className="shell pb-24 pt-6">
        {/* The only motion on a policy page: one quiet fade on the masthead. A
            document a reader may be checking a legal promise in should not be
            performing while they read it. */}
        <div className="legal-measure rise rise-1">
          <span className="eyebrow">{t('eyebrow')}</span>
          <h1 className="legal-title mt-4">{title}</h1>
          <p className="meta mt-3">{t('lastUpdated', { date: isoToDate(lastUpdatedIso) })}</p>

          <div className="legal-intro mt-8">{intro}</div>

          <p className="legal-disclaimer mt-6">
            <em>{t('disclaimer')}</em>
          </p>
        </div>

        <div className="mt-12 lg:grid lg:grid-cols-[17rem_minmax(0,1fr)] lg:items-start lg:gap-16">
          <nav className="legal-toc lg:sticky lg:top-8" aria-label={t('onThisPage')}>
            <p className="eyebrow">{t('onThisPage')}</p>
            <ol className="mt-3">
              {sections.map((section) => (
                <li key={section.id}>
                  <a href={`#${section.id}`} className="link">
                    {section.title}
                  </a>
                </li>
              ))}
            </ol>
          </nav>

          <div className="legal-body legal-measure mt-10 lg:mt-0">{children}</div>
        </div>

        <div className="legal-measure mt-16">
          <hr className="border-rule" />
          <p className="meta mt-6">
            {t('seeAlsoPre')}{' '}
            <a href={localeHref(locale, crossLinkHref)} className="link">
              {crossLinkLabel}
            </a>
            .
          </p>
        </div>
      </section>
    </main>
  );
}

/** One titled section within a legal page; the id anchors the table of contents. */
export function LegalSectionBlock({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="legal-section">
      <h2>{title}</h2>
      {children}
    </section>
  );
}
