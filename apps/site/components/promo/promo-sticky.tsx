'use client';

import { type ReactNode, useEffect, useState } from 'react';
import type { PromoPhase } from '~/lib/promo/holiday';

/**
 * Reveals the mobile promo bar after the first screen and hides it while the
 * offer section or the footer is on screen, so it never covers the real CTA.
 * Server HTML ships it hidden; with no JavaScript it simply never appears.
 */
export function PromoStickyReveal({ children, phase }: { children: ReactNode; phase: PromoPhase }) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const covered = new Set<Element>();
    let pastHero = false;
    const update = () => setShow(pastHero && covered.size === 0);
    const onScroll = () => {
      pastHero = window.scrollY > window.innerHeight * 0.6;
      update();
    };
    const targets = [document.getElementById('founding'), document.querySelector('footer')].filter(
      (el): el is HTMLElement => el !== null,
    );
    const io =
      typeof IntersectionObserver === 'undefined'
        ? null
        : new IntersectionObserver((entries) => {
            for (const entry of entries) {
              if (entry.isIntersecting) covered.add(entry.target);
              else covered.delete(entry.target);
            }
            update();
          });
    for (const el of targets) io?.observe(el);
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => {
      io?.disconnect();
      window.removeEventListener('scroll', onScroll);
    };
  }, []);
  return (
    <div
      className="rd promo-sticky"
      data-promo-phase={phase}
      data-show={show ? 'true' : 'false'}
      inert={!show}
    >
      <div className="promo-sticky-in">{children}</div>
    </div>
  );
}
