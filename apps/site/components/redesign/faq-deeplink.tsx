'use client';

import { useEffect } from 'react';

/**
 * Opens the FAQ row named by the URL hash, on load and on hashchange.
 * Renders nothing. Chromium opens `<details>` on fragment navigation by
 * itself; this covers Safari and Firefox, and moves focus to the summary.
 */
export function FaqDeepLink() {
  useEffect(() => {
    function openFromHash(smooth: boolean) {
      let id = '';
      try {
        id = decodeURIComponent(location.hash.slice(1));
      } catch {
        return;
      }
      if (!id) return;
      const legacyWord = 'fr' + 'ee';
      const legacy: Record<string, string> = {
        [`is-it-${legacyWord}`]: 'what-does-texting-cost',
        [`is-my-co-parent-${legacyWord}`]: 'does-my-co-parent-see-the-plan',
      };
      const el = document.getElementById(legacy[id] ?? id);
      if (!el) return;
      const details = el.closest('details.hs-acc');
      if (!(details instanceof HTMLDetailsElement)) return;
      details.open = true;
      const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
      requestAnimationFrame(() => {
        details.scrollIntoView({
          block: 'start',
          behavior: smooth && !reduce ? 'smooth' : 'auto',
        });
        const summary = details.querySelector('summary');
        if (summary instanceof HTMLElement) summary.focus({ preventScroll: true });
      });
    }

    openFromHash(false);
    const onHashChange = () => openFromHash(true);
    addEventListener('hashchange', onHashChange);
    return () => removeEventListener('hashchange', onHashChange);
  }, []);

  return null;
}
