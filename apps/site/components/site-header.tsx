'use client';

import { LogoMark } from '~/components/logo-mark';
import { ThemeToggle } from '~/components/theme-toggle';
import { APP_URL } from '~/lib/app-url';

/**
 * The marketing header: the turtle LogoMark beside the "Hale" wordmark on the
 * left; on the right, the value-first "See what Hale finds" CTA (restrained
 * outline — the hero carries the loud ask; the header stays calm), a quieter
 * "Log in" for returning parents, and the Light / Dark / System ThemeToggle.
 * No Pricing — everything is free right now. No "How it works" — the page below
 * is the explanation. Client component — the toggle reads/writes localStorage.
 */
export function SiteHeader() {
  return (
    <header className="shell flex items-center justify-between gap-3 pt-6 pb-2">
      <a href="/#top" className="flex shrink-0 items-center gap-3" aria-label="Hale, home">
        <LogoMark size={36} />
        <span className="font-display text-2xl leading-none font-semibold">Hale</span>
      </a>
      <div className="flex items-center gap-3 sm:gap-4">
        <a
          href={`${APP_URL}/sign-in`}
          className="hidden text-sm font-medium opacity-80 transition-opacity hover:opacity-100 sm:inline"
        >
          Log in
        </a>
        <a href={`${APP_URL}/preview`} className="btn-secondary btn-compact shrink-0 whitespace-nowrap">
          <span className="sm:hidden">What Hale finds</span>
          <span className="hidden sm:inline">See what Hale finds</span>
        </a>
        <ThemeToggle />
      </div>
    </header>
  );
}
