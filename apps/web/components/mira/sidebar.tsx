'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

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

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="sidebar">
      {/* Title slab — title + the slogan, treated like a book's title page */}
      <div>
        <Link href="/digest" className="block">
          <span className="font-display text-[2.4rem] leading-none">mira</span>
          <span className="meta block mt-2">an almanac for the family</span>
        </Link>

        <div className="mt-3 flex items-center gap-2">
          <span className="stamp">trial · day 3 of 7</span>
        </div>
      </div>

      <nav className="mt-10 space-y-0.5">
        {NAV.map((item) => {
          const active = pathname === item.href || pathname?.startsWith(`${item.href}/`);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? 'page' : undefined}
              className="nav-item"
            >
              <span className="nav-folio">{item.folio}</span>
              <span className="nav-label">{item.label}</span>
            </Link>
          );
        })}
      </nav>

      {/* "Today" — a small block of running data, like a date stamp on a journal entry */}
      <div className="mt-auto pt-10 space-y-3">
        <div className="rule-vellum" />
        <p className="eyebrow text-iron">today's run</p>
        <p className="meta tabular text-iron">
          14 passes · $0.31 · 1 awaits you
        </p>
        <p className="meta">
          mira drafts everything. nothing sends without your tap until day 8.
        </p>
      </div>
    </aside>
  );
}
