import type { ReactNode } from 'react';
import { SiteFooter } from '~/components/site-footer';
import { SiteHeader } from '~/components/site-header';
import { localeHref } from '~/i18n/navigation';
import type { Locale } from '~/i18n/routing';
import { getTranslator, isoToDate } from '~/i18n/server';

/** Shared legal presentation from the October handoff. Pages retain their existing policy copy. */

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
    <main id="main" tabIndex={-1} className="design-marketing">
      <div className="stage sp-stage sp-legal">
        <img
          className="shore-art"
          src="/landing-oct-2026/hale-shore-hero.webp"
          alt=""
          aria-hidden="true"
        />
        <span className="shore-scrim" aria-hidden="true" />
        <SiteHeader locale={locale} redesign />
        <section className="sp-hero">
          <div className="sp-grid">
            <div className="sp-copy">
              <h1 className="sp-h1">{title}</h1>
              <p className="sp-lede">{t('lastUpdated', { date: isoToDate(lastUpdatedIso) })}</p>
            </div>
          </div>
        </section>
      </div>
      <div className="hs-page">
        <section className="hs lg">
          <div className="hs-wrap hs-grid lg-wrap">
            <nav className="lg-toc" aria-label={t('onThisPage')}>
              <p className="sp-tag">{t('onThisPage')}</p>
              <ol>
                {sections.map((section) => (
                  <li key={section.id}>
                    <a href={`#${section.id}`}>{section.title}</a>
                  </li>
                ))}
              </ol>
            </nav>
            <div className="hs-glass lg-doc">
              <div>{intro}</div>
              <p>
                <em>{t('disclaimer')}</em>
              </p>
              {children}
              <p>
                {t('seeAlsoPre')} <a href={localeHref(locale, crossLinkHref)}>{crossLinkLabel}</a>.
              </p>
            </div>
          </div>
        </section>
      </div>
      <SiteFooter locale={locale} redesign />
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
