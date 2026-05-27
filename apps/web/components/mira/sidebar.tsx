'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LongDate } from './long-date';

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

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="sidebar">
      <Link href="/digest" className="block">
        <span className="font-display italic text-3xl leading-none">mira</span>
        <span className="meta block mt-1">a household platform</span>
      </Link>

      <div className="mt-12">
        <LongDate />
      </div>

      <nav className="mt-12 space-y-3">
        {NAV.map((item) => {
          const active = pathname === item.href || pathname?.startsWith(`${item.href}/`);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? 'page' : undefined}
              className="group flex items-baseline gap-3 py-1.5"
            >
              <span className="folio w-7 shrink-0">{item.folio}</span>
              <span
                className={`travel-underline text-lg ${
                  active ? 'text-ink' : 'text-ink-soft group-hover:text-ink'
                }`}
              >
                {item.label}
              </span>
            </Link>
          );
        })}
      </nav>

      <div className="mt-12 border-t border-hairline pt-6 space-y-3">
        <p className="eyebrow">today's run</p>
        <p className="meta tabular text-ink">
          <span className="text-ink">14</span> agent passes · <span className="text-ink">$0.31</span>
        </p>
        <p className="meta">1 item needs you</p>
      </div>

      <div className="mt-12 text-ink-mute">
        <p className="meta">trial mode · day 3 of 7</p>
        <p className="meta mt-1">mira drafts everything; nothing sends without your tap.</p>
      </div>
    </aside>
  );
}
