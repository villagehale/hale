'use client';

import Link from 'next/link';
import { useState } from 'react';

const NAV = [
  { href: '/digest', label: 'digest' },
  { href: '/live', label: 'live' },
  { href: '/drafts', label: 'drafts' },
  { href: '/coach', label: 'coach' },
  { href: '/memory', label: 'memory' },
  { href: '/trail', label: 'trail' },
  { href: '/connected', label: 'connected' },
  { href: '/settings', label: 'settings' },
] as const;

/**
 * Mobile-only sticky top header. Tap the logo to open the nav sheet.
 */
export function TopHeader() {
  const [open, setOpen] = useState(false);

  return (
    <header className="top-header">
      <Link href="/digest" className="font-display text-2xl leading-none">
        mira
      </Link>

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="eyebrow text-ink"
        aria-expanded={open}
      >
        {open ? 'close' : 'menu'}
      </button>

      {open ? (
        <nav className="absolute left-0 right-0 top-full border-b border-hairline bg-cream">
          <ul className="px-[var(--shell-pad-x)] py-6 space-y-4">
            {NAV.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className="font-display text-2xl"
                  onClick={() => setOpen(false)}
                >
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}
    </header>
  );
}
