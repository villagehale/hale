'use client';

import { useEffect } from 'react';
import { resolveSection } from '~/components/hale/settings-sections';

/**
 * The one centered Settings lane (Instinct-adapted refresh) — a scrolling column
 * that replaced the 216px sub-nav hub. This client wrapper only restores the anchor
 * model for deep links: on mount and on hashchange the URL hash (old #billing,
 * #privacy, the hub's ids…) resolves through settings-sections to the section it
 * should land on, and the page scrolls there. The section bodies are server-rendered
 * children; nothing else is owned here.
 */
export function SettingsColumn({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    const go = () => {
      if (!window.location.hash) return;
      document.getElementById(resolveSection(window.location.hash))?.scrollIntoView();
    };
    go();
    window.addEventListener('hashchange', go);
    return () => window.removeEventListener('hashchange', go);
  }, []);

  return <div className="settings-col rise rise-2">{children}</div>;
}
