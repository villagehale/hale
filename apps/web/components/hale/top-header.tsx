'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { LogoMark } from '~/components/hale/logo-mark';
import { ThemeToggle } from '~/components/hale/theme-toggle';

const NAV = [
  { href: '/digest', label: 'digest', folio: '01' },
  { href: '/live', label: 'live', folio: '02' },
  { href: '/drafts', label: 'drafts', folio: '03' },
  { href: '/coach', label: 'coach', folio: '04' },
  { href: '/memory', label: 'memory', folio: '05' },
  { href: '/trail', label: 'trail', folio: '06' },
  { href: '/connected', label: 'connected', folio: '07' },
  { href: '/settings', label: 'settings', folio: '08' },
] as const;

/**
 * Mobile running head — the top edge of an open book. Tap the title
 * to open the nav sheet. Tap any nav item to close it again.
 */
export function TopHeader() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  const current = NAV.find(
    (n) => pathname === n.href || pathname?.startsWith(`${n.href}/`)
  );

  return (
    <header className="runninghead">
      <div className="flex items-center gap-3">
        <Link href="/digest" className="flex items-center gap-2">
          <LogoMark size={28} />
          <span className="font-display text-2xl leading-none font-semibold">Hale</span>
        </Link>
        {current ? (
          <span className="eyebrow text-spruce">{current.label}</span>
        ) : null}
      </div>

      <div className="flex items-center gap-3">
        <ThemeToggle />
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="eyebrow text-spruce"
          aria-expanded={open}
        >
          {open ? 'close' : 'index'}
        </button>
      </div>

      {open ? (
        <nav className="absolute left-0 right-0 top-full bg-oat">
          <ul className="px-[var(--shell-pad-x)] py-6 space-y-1">
            {NAV.map((item) => {
              const active = item === current;
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active ? 'page' : undefined}
                    className="nav-item"
                    onClick={() => setOpen(false)}
                  >
                    <span className="nav-folio">{item.folio}</span>
                    <span className="nav-label">{item.label}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      ) : null}
    </header>
  );
}
