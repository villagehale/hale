'use client';

import { Menu, X } from 'lucide-react';
import { useState } from 'react';
import { LandingCta } from '~/components/landing-cta';
import { LogoMark } from '~/components/logo-mark';
import { ThemeToggle } from '~/components/theme-toggle';
import { APP_URL } from '~/lib/app-url';
import { chromeCta } from '~/lib/site/chrome-cta';

/**
 * The marketing header — ONE bar, on the homepage and on every subpage.
 *
 * Until this change there were two: the landing carried its own inline header
 * (glass, dark-aware, no nav) while eight subpages used this component
 * (light-only, and with a "Features" link whose destination was the homepage — a
 * nav item that navigated nowhere). A reader crossing from / to /pricing changed
 * products. There is no page for "Features", so there is no link: the four pages
 * the site actually has are the four links in the bar.
 *
 * Sticky rather than fixed, so subpages — which have no hero top-padding — flow
 * below the bar instead of under it. The surface is `.site-glass`: a translucent
 * wash of the page ground with a blur and a masked gradient hairline, tuned per
 * theme in globals.css.
 *
 * Below `lg` the links collapse behind a hamburger, but the CTA and the theme
 * toggle both stay in the bar at every width — the CTA because it is the only
 * conversion surface the site has, the toggle because a reader on a phone at
 * night is exactly who needs it. The nav is optically centred, which is what
 * sets that breakpoint: at 768px the centred row and the right-hand cluster meet
 * (measured), and a nav that touches the theme icon is worse than a hamburger.
 *
 * `scrollTargetId` is the landing's one variation. `sms:` opens nothing on a
 * laptop, so where the page has a CTA block to fall back to, the desktop pill
 * scrolls there instead of firing a dead link. A subpage has no such block and
 * passes nothing; an email CTA works everywhere and never splits.
 */

const LINKS = [
  { label: 'About', href: '/about' },
  { label: 'Pricing', href: '/pricing' },
  { label: 'FAQ', href: '/faq' },
  { label: 'Contact', href: '/contact' },
] as const;

const SIGN_IN = `${APP_URL}/sign-in`;

export function SiteHeader({ scrollTargetId }: { scrollTargetId?: string }) {
  const [open, setOpen] = useState(false);
  const cta = chromeCta();
  const splitByDevice = scrollTargetId !== undefined && cta.href.startsWith('sms:');

  return (
    <header className="site-glass sticky top-0 z-50">
      <div className="shell relative flex items-center justify-between gap-3 py-3">
        <a href="/" className="flex shrink-0 items-center gap-2.5" aria-label="Hale, home">
          <LogoMark size={30} />
          <span className="font-serif text-[1.35rem] font-semibold leading-none text-spruce">
            Hale
          </span>
        </a>

        <nav
          aria-label="Primary"
          className="absolute left-1/2 hidden -translate-x-1/2 items-center gap-8 lg:flex"
        >
          {LINKS.map((link) => (
            <a key={link.label} href={link.href} className="chrome-link">
              {link.label}
            </a>
          ))}
        </nav>

        <div className="flex shrink-0 items-center gap-1 sm:gap-2">
          <ThemeToggle />
          <a href={SIGN_IN} className="chrome-link hidden px-2 py-1 sm:inline-flex">
            Sign in
          </a>
          {splitByDevice ? (
            <>
              <LandingCta
                event="landing_cta_text"
                href={cta.href}
                className="btn-primary btn-compact min-h-11 sm:hidden"
              >
                {cta.label}
              </LandingCta>
              <a
                href={`#${scrollTargetId}`}
                className="btn-primary btn-compact hidden min-h-11 sm:inline-flex"
              >
                {cta.label}
              </a>
            </>
          ) : (
            <LandingCta
              event="landing_cta_text"
              href={cta.href}
              className="btn-primary btn-compact min-h-11"
            >
              {cta.label}
            </LandingCta>
          )}
          <button
            type="button"
            aria-label={open ? 'Close menu' : 'Open menu'}
            aria-expanded={open}
            aria-controls="mobile-nav"
            onClick={() => setOpen((v) => !v)}
            className="chrome-icon-btn lg:hidden"
          >
            {open ? <X size={22} strokeWidth={1.75} /> : <Menu size={22} strokeWidth={1.75} />}
          </button>
        </div>
      </div>

      <div
        id="mobile-nav"
        inert={!open ? true : undefined}
        className={`grid overflow-hidden transition-[grid-template-rows,opacity] duration-300 motion-reduce:transition-none lg:hidden ${
          open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
        }`}
      >
        <div className="min-h-0">
          <nav aria-label="Mobile" className="shell flex flex-col gap-1 pb-4 pt-1">
            {LINKS.map((link) => (
              <a
                key={link.label}
                href={link.href}
                onClick={() => setOpen(false)}
                className="rounded-lg px-2 py-3 text-base font-medium text-spruce hover:bg-hair"
              >
                {link.label}
              </a>
            ))}
            <a
              href={SIGN_IN}
              onClick={() => setOpen(false)}
              className="rounded-lg px-2 py-3 text-base font-medium text-slate-green hover:bg-hair hover:text-spruce"
            >
              Sign in
            </a>
          </nav>
        </div>
      </div>
    </header>
  );
}
