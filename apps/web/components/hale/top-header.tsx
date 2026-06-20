'use client';

import type { Route } from 'next';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  CalendarRange,
  History,
  House,
  Home as HomeIcon,
  Menu,
  MessageCircleHeart,
  Sparkles,
  Users,
} from 'lucide-react';
import { Icon } from '~/components/ui/icon';
import { useShell } from '~/components/hale/app-shell';
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
 * The sticky header frame above the scrolling main stage. The brand and the
 * current-page eyebrow sit on the running head; the hamburger (mobile only)
 * opens the off-canvas nav drawer.
 */
export function TopHeader() {
  const pathname = usePathname();
  const { openDrawer, drawerOpen } = useShell();

  const current = NAV.find((n) => pathname === n.href || pathname?.startsWith(`${n.href}/`));

  return (
    <header className="runninghead">
      <div className="runninghead-lead">
        <button
          type="button"
          onClick={openDrawer}
          className="runninghead-menu"
          aria-label="Open menu"
          aria-expanded={drawerOpen}
        >
          <Icon as={Menu} size={22} />
        </button>
        <Link href="/home" className="runninghead-brand">
          <LogoMark size={28} />
          <span className="font-display text-2xl leading-none font-semibold">Hale</span>
        </Link>
        {current ? <span className="eyebrow text-spruce">{current.label}</span> : null}
      </div>

      <div className="runninghead-trail">
        <ThemeToggle />
      </div>
    </header>
  );
}
