'use client';

import { Menu, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { LandingCta } from '~/components/landing-cta';
import { LogoMark } from '~/components/logo-mark';
import { APP_URL } from '~/lib/app-url';

/**
 * The marketing header: a sticky, responsive nav shared across the homepage and
 * every subpage. Transparent over the warm page at the top; after 20px of
 * scroll it settles into a translucent, blurred bar with a hairline. Center
 * links deep-link to the homepage sections (About goes to /about); the right
 * "Get started" pill is the funnel top (captured via LandingCta). On mobile the
 * links collapse behind a hamburger that opens a dropdown and auto-closes on tap.
 *
 * Sticky (not fixed) so subpages — which have no hero top-padding — still flow
 * below the bar instead of hiding under it.
 */

const LINKS = [
  { label: 'About', href: '/about' },
  { label: 'Features', href: '/#features' },
  { label: 'Pricing', href: '/pricing' },
  { label: 'FAQ', href: '/#faq' },
  { label: 'Contact', href: '/#contact' },
] as const;

export function SiteHeader() {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 20);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <header
      className={`sticky top-0 z-50 transition-colors duration-300 ${
        scrolled
          ? 'border-b border-[#F0F2F6] bg-[#FDFCFA]/80 backdrop-blur-md'
          : 'border-b border-transparent'
      }`}
    >
      <div className="relative mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
        <a href="/#about" className="flex shrink-0 items-center gap-2.5" aria-label="Hale, home">
          <LogoMark size={34} />
          <span className="font-serif text-[1.35rem] font-semibold leading-none text-[#17294A]">
            Hale
          </span>
        </a>

        <nav
          aria-label="Primary"
          className="absolute left-1/2 hidden -translate-x-1/2 items-center gap-8 md:flex"
        >
          {LINKS.map((link) => (
            <a
              key={link.label}
              href={link.href}
              className="rounded-sm text-sm font-medium text-[#5C6B87] transition-colors hover:text-[#17294A] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#17294A]"
            >
              {link.label}
            </a>
          ))}
        </nav>

        <div className="flex items-center gap-2">
          <LandingCta
            event="landing_cta_signin"
            href={`${APP_URL}/onboarding`}
            className="hidden rounded-full bg-[#17294A] px-5 py-2.5 text-sm font-semibold text-[#F7F4EC] transition-colors hover:bg-[#101d36] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#17294A] sm:inline-flex"
          >
            Get started
          </LandingCta>
          <button
            type="button"
            aria-label={open ? 'Close menu' : 'Open menu'}
            aria-expanded={open}
            aria-controls="mobile-nav"
            onClick={() => setOpen((v) => !v)}
            className="inline-flex h-10 w-10 items-center justify-center rounded-full text-[#17294A] transition-colors hover:bg-[#F0F2F6] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#17294A] md:hidden"
          >
            {open ? <X size={22} strokeWidth={1.75} /> : <Menu size={22} strokeWidth={1.75} />}
          </button>
        </div>
      </div>

      <div
        id="mobile-nav"
        inert={!open ? true : undefined}
        className={`grid overflow-hidden border-[#F0F2F6] bg-[#FDFCFA]/95 backdrop-blur-md transition-[grid-template-rows,opacity] duration-300 motion-reduce:transition-none md:hidden ${
          open ? 'grid-rows-[1fr] border-b opacity-100' : 'grid-rows-[0fr] opacity-0'
        }`}
      >
        <div className="min-h-0">
          <nav aria-label="Mobile" className="mx-auto flex max-w-7xl flex-col gap-1 px-6 py-4">
            {LINKS.map((link) => (
              <a
                key={link.label}
                href={link.href}
                onClick={() => setOpen(false)}
                className="rounded-lg px-2 py-3 text-base font-medium text-[#17294A] transition-colors hover:bg-[#F0F2F6]"
              >
                {link.label}
              </a>
            ))}
            <LandingCta
              event="landing_cta_signin"
              href={`${APP_URL}/onboarding`}
              className="mt-2 inline-flex justify-center rounded-full bg-[#17294A] px-5 py-3 text-sm font-semibold text-[#F7F4EC] transition-colors hover:bg-[#101d36]"
            >
              Get started
            </LandingCta>
          </nav>
        </div>
      </div>
    </header>
  );
}
