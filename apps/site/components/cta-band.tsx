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
      <section className="shell pb-16">
        <div className="cta-band w-full rounded-[28px] px-8 py-16 text-center">{children}</div>
      </section>
    </FadeInUp>
  );
}
