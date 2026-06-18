'use client';

import { LogoMark } from '~/components/logo-mark';
import { ThemeToggle } from '~/components/theme-toggle';

/**
 * The marketing header: the turtle LogoMark beside the "Hale" wordmark on the
 * left, the research-preview pill and the Light / Dark / System ThemeToggle on
 * the right. Client component — the toggle reads and writes localStorage.
 */
export function SiteHeader() {
  return (
    <header className="shell flex items-center justify-between gap-4 pt-6 pb-2">
      <a href="#top" className="flex items-center gap-3" aria-label="Hale, home">
        <LogoMark size={36} />
        <span className="font-display text-2xl leading-none font-semibold">Hale</span>
      </a>
      <div className="flex items-center gap-3">
        <span className="hidden sm:block">
          <span className="pill pill-apricot">research preview</span>
        </span>
        <ThemeToggle />
      </div>
    </header>
  );
}
