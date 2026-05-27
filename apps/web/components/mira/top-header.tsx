'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';

const NAV = [
  { href: '/digest', label: 'digest', folio: 'i' },
  { href: '/live', label: 'live', folio: 'ii' },
  { href: '/drafts', label: 'drafts', folio: 'iii' },
  { href: '/coach', label: 'coach', folio: 'iv' },
  { href: '/memory', label: 'memory', folio: 'v' },
  { href: '/trail', label: 'trail', folio: 'vi' },
  { href: '/connected', label: 'connected', folio: 'vii' },
  { href: '/settings', label: 'settings', folio: 'viii' },
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
      <div className="flex items-baseline gap-3">
        <Link href="/digest" className="font-display text-2xl leading-none">
          mira
        </Link>
        {current ? (
          <span className="eyebrow text-iron">{current.label}</span>
        ) : null}
      </div>

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="eyebrow text-iron"
        aria-expanded={open}
      >
        {open ? 'close' : 'index'}
      </button>

      {open ? (
        <nav className="absolute left-0 right-0 top-full border-b border-rule bg-bone">
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
