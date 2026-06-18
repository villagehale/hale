'use client';

import type { Route } from 'next';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import {
  CalendarRange,
  History,
  House,
  Home as HomeIcon,
  MessageCircleHeart,
  Sparkles,
  Users,
} from 'lucide-react';
import { Icon } from '~/components/ui/icon';
import { LogoMark } from '~/components/hale/logo-mark';
import { ThemeToggle } from '~/components/hale/theme-toggle';

const NAV = [
  { href: '/home', label: 'home', icon: HomeIcon },
  { href: '/coach', label: 'ask Hale', icon: MessageCircleHeart },
  { href: '/companion', label: 'companion', icon: Sparkles },
  { href: '/village', label: 'village', icon: Users },
  { href: '/plan', label: 'plan', icon: CalendarRange },
  { href: '/settings', label: 'family', icon: House },
  { href: '/trail', label: 'history', icon: History },
] as const satisfies ReadonlyArray<{ href: Route; label: string; icon: typeof HomeIcon }>;

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
        <Link href="/home" className="flex items-center gap-2">
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
          {open ? 'close' : 'menu'}
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
                    <span className="nav-folio">
                      <Icon as={item.icon} size={18} />
                    </span>
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
