import type { ReactNode } from 'react';
import { APP_URL } from '~/lib/app-url';

/**
 * The long-form shell for /terms and /privacy on the marketing domain
 * (VIL-250 · M14 · B-legal): the brand line, a reading column, an in-page table
 * of contents that becomes a sticky sidebar on desktop, the not-legal-advice
 * note, and the cross-link to the other policy. Pages own only their copy.
 *
 * Deliberately without the site header and footer. The policies are a
 * destination a parent arrives at from a text message or an email footer, not a
 * step in a funnel — and the marketing chrome would pull them back into one.
 */

export interface LegalSection {
  id: string;
  title: string;
}

export function LegalLayout({
  title,
  lastUpdated,
  intro,
  sections,
  children,
  crossLinkHref,
  crossLinkLabel,
}: {
  title: string;
  lastUpdated: string;
  intro: ReactNode;
  sections: LegalSection[];
  children: ReactNode;
  crossLinkHref: string;
  crossLinkLabel: string;
}) {
  return (
    <main id="main" tabIndex={-1}>
      <header className="shell legal-print-hide flex items-center justify-between py-6">
        <a href="/" className="font-serif text-[1.35rem] font-semibold leading-none text-spruce">
          Hale
        </a>
        <a href={`${APP_URL}/sign-in`} className="py-1 text-sm font-medium text-slate-green">
          Sign in
        </a>
      </header>

      <section className="shell pb-24 pt-6">
        {/* The only motion on a policy page: one quiet fade on the masthead. A
            document a reader may be checking a legal promise in should not be
            performing while they read it. */}
        <div className="legal-measure rise rise-1">
          <span className="eyebrow">Legal</span>
          <h1 className="legal-title mt-4">{title}</h1>
          <p className="meta mt-3">Last updated {lastUpdated}</p>

          <div className="legal-intro mt-8">{intro}</div>

          <p className="legal-disclaimer mt-6">
            <em>
              This document is provided in good faith but is not legal advice. Hale should have it
              reviewed by a qualified lawyer before relying on it.
            </em>
          </p>
        </div>

        <div className="mt-12 lg:grid lg:grid-cols-[17rem_minmax(0,1fr)] lg:items-start lg:gap-16">
          <nav className="legal-toc lg:sticky lg:top-8" aria-label="On this page">
            <p className="eyebrow">On this page</p>
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
            See also our{' '}
            <a href={crossLinkHref} className="link">
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
