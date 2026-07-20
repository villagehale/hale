'use client';

import { useEffect, useState } from 'react';

/** The desktop breakpoint shared with the CSS (the top bar appears, modals center)
 * — kept in one place so JS and globals.css can never disagree. */
export const DESKTOP_MIN_WIDTH = 1024;

/**
 * True at ≥1024px (the design handoff's desktop breakpoint). Starts false so the
 * server render and first client paint agree (no hydration mismatch); the effect
 * corrects it after mount and on every viewport change. Consumers only read it to
 * choose a PRESENTATION (a centered modal vs. the inline panel) for content that
 * appears after a user interaction, so the initial false is never seen.
 */
export function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia(`(min-width: ${DESKTOP_MIN_WIDTH}px)`);
    const sync = () => setIsDesktop(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  return isDesktop;
}
