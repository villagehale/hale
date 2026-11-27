'use client';

import { type ReactNode, useEffect, useState } from 'react';
import { PROMO_OFFER_ID, type PromoPhase } from '~/lib/promo/holiday';
import { type StickyCoverBlock, promoStickyVisible } from '~/lib/promo/sticky-visibility';

/**
 * Reveals the mobile promo bar after the first screen and hides it while the
 * offer covers the page or the footer is on screen, so it never covers the
 * real CTA. Server HTML ships it hidden; with no JavaScript it simply never
 * appears.
 */
export function PromoStickyReveal({
  children,
  phase,
  className,
}: {
  children: ReactNode;
  phase: PromoPhase;
  className?: string;
}) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const measure = () => {
      const scrollY = window.scrollY;
      const blocks: StickyCoverBlock[] = [];
      const offer = document.getElementById(PROMO_OFFER_ID);
      const footer = document.querySelector('footer');
      if (offer) {
        const rect = offer.getBoundingClientRect();
        blocks.push({ kind: 'offer', top: rect.top + scrollY, bottom: rect.bottom + scrollY });
      }
      if (footer) {
        const rect = footer.getBoundingClientRect();
        blocks.push({ kind: 'footer', top: rect.top + scrollY, bottom: rect.bottom + scrollY });
      }
      setShow(
        promoStickyVisible({
          scrollY,
          viewportHeight: window.innerHeight,
          blocks,
        }),
      );
    };
    const targets = [
      document.getElementById(PROMO_OFFER_ID),
      document.querySelector('footer'),
    ].filter((el): el is HTMLElement => el !== null);
    const io =
      typeof IntersectionObserver === 'undefined'
        ? null
        : new IntersectionObserver(() => {
            measure();
          });
    for (const el of targets) io?.observe(el);
    window.addEventListener('scroll', measure, { passive: true });
    window.addEventListener('resize', measure);
    measure();
    return () => {
      io?.disconnect();
      window.removeEventListener('scroll', measure);
      window.removeEventListener('resize', measure);
    };
  }, []);
  return (
    <div
      className={className ? `rd promo-sticky ${className}` : 'rd promo-sticky'}
      data-promo-phase={phase}
      data-show={show ? 'true' : 'false'}
      inert={!show}
    >
      <div className="promo-sticky-in">{children}</div>
    </div>
  );
}
