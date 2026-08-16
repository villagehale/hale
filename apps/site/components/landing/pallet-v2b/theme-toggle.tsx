'use client';

import { useState } from 'react';

/**
 * Light/dark switch for the preview only. The marketing site is light-only in
 * production; this exists so the founder can compare both themes on one URL.
 * Writes `data-theme` on <html>, which the v2b token blocks read — the OS
 * preference still wins until someone presses this.
 */
export function ThemeToggle() {
  const [theme, setTheme] = useState<'light' | 'dark' | null>(null);

  const flip = () => {
    const current =
      theme ??
      (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    setTheme(next);
  };

  return (
    <button type="button" className="v2b-themetoggle" onClick={flip}>
      {theme === 'dark' ? 'Light' : 'Dark'}
    </button>
  );
}
