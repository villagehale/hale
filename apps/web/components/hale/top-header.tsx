'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Menu } from 'lucide-react';
import { Icon } from '~/components/ui/icon';
import { useShell } from '~/components/hale/app-shell';
import { LogoMark } from '~/components/hale/logo-mark';
import { ALL_NAV } from '~/components/hale/nav';
import { ThemeToggle } from '~/components/hale/theme-toggle';

/**
 * The sticky header frame above the scrolling main stage. The brand and the
 * current-page eyebrow sit on the running head; the hamburger (mobile only)
 * opens the off-canvas nav drawer.
 */
export function TopHeader() {
  const pathname = usePathname();
  const { openDrawer, drawerOpen } = useShell();

  const current = ALL_NAV.find((n) => pathname === n.href || pathname?.startsWith(`${n.href}/`));

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
