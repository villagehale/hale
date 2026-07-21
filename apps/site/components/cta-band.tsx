import type { ReactNode } from 'react';
import { FadeInUp } from '~/components/landing/fade-in-up';

/**
 * The homepage's closing statement surface, reused across the subpages: a
 * deep-navy rounded band that scroll-reveals into view. Callers pass their
 * existing CTA content verbatim (statement, byline, and action links) so copy,
 * hrefs, and analytics events stay untouched — this only supplies the navy
 * surface and centered rhythm. Colours invert to cream via the `.cta-band`
 * rule in globals.css.
 */
export function CtaBand({ children }: { children: ReactNode }) {
  return (
    <FadeInUp>
      <section className="px-4 pb-16 sm:px-6 lg:pb-24">
        <div className="cta-band mx-auto max-w-[1100px] rounded-[28px] px-6 py-14 text-center sm:px-12 md:py-20">
          {children}
        </div>
      </section>
    </FadeInUp>
  );
}
