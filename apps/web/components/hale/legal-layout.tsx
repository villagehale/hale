import Link from 'next/link';
import type { ReactNode } from 'react';
import { LogoMark } from './logo-mark';
import { ThemeToggle } from './theme-toggle';

export const LEGAL_LAST_UPDATED = 'June 25, 2026';

export interface LegalSection {
  id: string;
  title: string;
}

/**
 * Shared shell for the Terms and Privacy pages: the brand header, a tightened
 * long-form reading column (.legal), an in-page table of contents, the
 * "not legal advice" note, the last-updated line, and the cross-link to the
 * other policy. The pages own only their section copy.
 */
export function LegalLayout({
  eyebrow,
  title,
  intro,
  sections,
  children,
  crossLinkHref,
  crossLinkLabel,
}: {
  eyebrow: string;
  title: string;
  intro: ReactNode;
  sections: LegalSection[];
  children: ReactNode;
  crossLinkHref: string;
  crossLinkLabel: string;
}) {
  return (
    <main className="min-h-screen bg-linen">
      <header className="shell flex items-center justify-between pt-8 pb-2">
        <Link href="/" className="flex items-center gap-3">
          <LogoMark size={32} />
          <span className="font-display text-2xl font-semibold">Village Hale</span>
        </Link>
        <ThemeToggle />
      </header>

      <section className="shell pt-12 pb-24 legal">
        <span className="eyebrow">{eyebrow}</span>
        <h1 className="mt-4 font-display legal-title">{title}</h1>
        <p className="meta mt-3">Last updated {LEGAL_LAST_UPDATED}</p>

        <div className="legal-intro mt-8">{intro}</div>

        <p className="legal-disclaimer mt-6">
          <em>
            This document is provided in good faith but is not legal advice. Hale should have it
            reviewed by a qualified lawyer before relying on it.
          </em>
        </p>

        <nav className="legal-toc mt-10" aria-label="On this page">
          <p className="eyebrow">On this page</p>
          <ol className="mt-3">
            {sections.map((s) => (
              <li key={s.id}>
                <a href={`#${s.id}`} className="link">
                  {s.title}
                </a>
              </li>
            ))}
          </ol>
        </nav>

        <div className="legal-body mt-12">{children}</div>

        <hr className="rule legal-footer-rule mt-16" />
        <p className="meta mt-6">
          See also our{' '}
          <Link href={crossLinkHref} className="link">
            {crossLinkLabel}
          </Link>
          .
        </p>
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
      <h2 className="font-display">{title}</h2>
      {children}
    </section>
  );
}
