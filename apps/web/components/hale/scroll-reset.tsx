'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';

/**
 * The authed app scrolls inside `<main class="main-stage">` (overflow-y:auto), not
 * the window, so Next's per-navigation window-scroll reset never touches it. This
 * resets the stage to the top on every client navigation. (Browser reload is
 * handled separately by scrollRestoration:'manual', set pre-paint in the root
 * layout — otherwise the browser re-applies the stage's old offset after mount.)
 * The extra rAF re-assert beats any late shift as the new route's content lands.
 */
export function ScrollReset() {
  const pathname = usePathname();

  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname is the intended trigger, not a value read in the body
  useEffect(() => {
    const stage = document.querySelector('.main-stage');
    if (!stage) return;
    stage.scrollTo({ top: 0 });
    const raf = requestAnimationFrame(() => stage.scrollTo({ top: 0 }));
    return () => cancelAnimationFrame(raf);
  }, [pathname]);

  return null;
}
