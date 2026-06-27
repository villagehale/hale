'use client';

import { LogoMark } from '~/components/logo-mark';
import { ThemeToggle } from '~/components/theme-toggle';
import { APP_URL } from '~/lib/app-url';

/**
 * The marketing header: the turtle LogoMark beside the "Hale" wordmark on the
 * left, the Log in link and the Light / Dark / System ThemeToggle on the right.
 * Client component — the toggle reads and writes localStorage.
 */
export function SiteHeader() {
  return (
    <header className="shell flex items-center justify-between gap-4 pt-6 pb-2">
      <a href="#top" className="flex items-center gap-3" aria-label="Hale, home">
        <LogoMark size={36} />
        <span className="font-display text-2xl leading-none font-semibold">Hale</span>
      </a>
      <div className="flex items-center gap-3">
        <a
          href={`${APP_URL}/sign-in`}
          className="text-sm font-medium opacity-80 transition-opacity hover:opacity-100"
        >
          Log in
        </a>
        <ThemeToggle />
      </div>
    </header>
  );
}
