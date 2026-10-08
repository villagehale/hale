import type { ReactNode } from 'react';
import { LegalToc } from '~/components/legal-toc';
import { shoreSrc } from '~/components/redesign/assets';
import { SiteFooter } from '~/components/site-footer';
import { SiteHeader } from '~/components/site-header';
import { localeHref } from '~/i18n/navigation';
import type { Locale } from '~/i18n/routing';
import { getTranslator, isoToDate } from '~/i18n/server';

/**
 * The long-form shell for /terms and /privacy on the marketing domain
 * (VIL-250 · M14 · B-legal): the brand line, a reading column, an in-page table
 * of contents that becomes a sticky sidebar on desktop, the not-legal-advice
 * note, and the cross-link to the other policy. Pages own only their copy.
 *
 * The redesign wears the same site header and footer as every other page.
 * The policy itself stays a document: shore title, sticky contents, frosted
 * panel, and no closing band.
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
    <>
      <SiteHeader locale={locale} chrome="legal" />
      <div className="rd">
        <div className="stage sp-stage sp-legal">
          <img className="shore-art" src={shoreSrc} alt="" aria-hidden="true" />
          <span className="shore-drift sky" aria-hidden="true" />
          <span className="shore-drift sea" aria-hidden="true" />
          <span className="shore-scrim" aria-hidden="true" />
          <main id="main" className="sp-hero">
            <div className="sp-grid">
              <div className="sp-copy">
                <p className="hs-eyebrow">{t('eyebrow')}</p>
                <h1 className="sp-h1">{title}</h1>
                <p className="sp-lede">{t('lastUpdated', { date: isoToDate(lastUpdatedIso) })}</p>
              </div>
            </div>
          </main>
        </div>
        <div className="hs-page">
          <section className="hs lg hs-wash-a">
            <div className="hs-wrap hs-grid lg-wrap">
              <LegalToc label={t('onThisPage')} sections={sections} />
              <article className="hs-glass lg-doc">
                <div className="legal-intro">{intro}</div>
                <p>
                  <em>{t('disclaimer')}</em>
                </p>
                {children}
                <p>
                  {t('seeAlsoPre')}{' '}
                  <a href={localeHref(locale, crossLinkHref)} className="link">
                    {crossLinkLabel}
                  </a>
                  .
                </p>
              </article>
            </div>
          </section>
        </div>
      </div>
      <SiteFooter locale={locale} />
    </>
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
