'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';

/**
 * The authed app scrolls inside `<main class="main-stage">` (overflow-y:auto),
 * not the window — so Next's per-navigation window-scroll reset never touches it,
 * and a new route opens wherever the previous one was scrolled. Mounted once in
 * the authed layout, this resets the stage to the top on every path change.
 */
export function ScrollReset() {
  const pathname = usePathname();

  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname is the intended trigger, not a value read in the body
  useEffect(() => {
    document.querySelector('.main-stage')?.scrollTo({ top: 0 });
  }, [pathname]);

  return null;
}
