'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { SeaTurtle } from '~/components/illos';

const NAV = [
  { href: '/digest', label: 'digest', folio: '01' },
  { href: '/live', label: 'live', folio: '02' },
  { href: '/drafts', label: 'drafts', folio: '03' },
  { href: '/coach', label: 'coach', folio: '04' },
  { href: '/memory', label: 'memory', folio: '05' },
  { href: '/trail', label: 'trail', folio: '06' },
  { href: '/connected', label: 'connected', folio: '07' },
  { href: '/settings', label: 'settings', folio: '08' },
  { href: '/village', label: 'village', folio: '09' },
] as const;

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="sidebar">
      <div>
        <Link href="/digest" className="block">
          <span
            className="font-display text-[2.4rem] leading-none"
            style={{ fontVariationSettings: '"opsz" 96, "SOFT" 50, "WONK" 0' }}
          >
            Hale
          </span>
          <span className="meta block mt-2">holds the small things</span>
        </Link>

        <div className="mt-4">
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

      {/* "Today" — a small block of running data */}
      <div className="mt-auto pt-10 space-y-3">
        <div className="rule" />
        <p className="eyebrow text-spruce pt-1">today</p>
        <dl className="meta text-spruce space-y-1">
          <div className="flex items-baseline justify-between gap-2">
            <dt>passes</dt>
            <dd className="tabular">14</dd>
          </div>
          <div className="flex items-baseline justify-between gap-2">
            <dt>cost</dt>
            <dd className="tabular">$0.31</dd>
          </div>
          <div className="flex items-baseline justify-between gap-2">
            <dt>awaiting</dt>
            <dd className="tabular">1</dd>
          </div>
        </dl>

        {/* The one tasteful sea turtle — Hale, resting at the foot. */}
        <div className="pt-4 flex items-end gap-3" aria-hidden>
          <SeaTurtle age="hatchling" style={{ height: 44, width: 'auto' }} />
          <span className="meta">resting · listening</span>
        </div>
      </div>
    </aside>
  );
}
