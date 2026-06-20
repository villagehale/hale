'use client';

import type { Route } from 'next';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  CalendarRange,
  History,
  House,
  Home as HomeIcon,
  MessageCircleHeart,
  PanelLeftClose,
  PanelLeftOpen,
  Sparkles,
  Users,
  X,
} from 'lucide-react';
import { SeaTurtle } from '~/components/illos';
import { Icon } from '~/components/ui/icon';
import { useShell } from '~/components/hale/app-shell';
import { LogoMark } from '~/components/hale/logo-mark';
import { ThemeToggle } from '~/components/hale/theme-toggle';
import { signOutAction } from '~/lib/auth-actions';

const NAV = [
  { href: '/home', label: 'home', icon: HomeIcon },
  { href: '/coach', label: 'ask Hale', icon: MessageCircleHeart },
  { href: '/companion', label: 'companion', icon: Sparkles },
  { href: '/village', label: 'village', icon: Users },
  { href: '/plan', label: 'plan', icon: CalendarRange },
  { href: '/settings', label: 'family', icon: House },
] as const satisfies ReadonlyArray<{ href: Route; label: string; icon: typeof HomeIcon }>;

function NavLink({
  href,
  label,
  icon,
  active,
  onNavigate,
}: {
  href: Route;
  label: string;
  icon: typeof HomeIcon;
  active: boolean;
  onNavigate: () => void;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className="nav-item"
      onClick={onNavigate}
    >
      <span className="nav-folio">
        <Icon as={icon} size={18} />
      </span>
      <span className="nav-label">{label}</span>
      <span className="nav-tip" role="tooltip">
        {label}
      </span>
    </Link>
  );
}

export function Sidebar({
  authControls = false,
  signedIn = false,
}: {
  authControls?: boolean;
  signedIn?: boolean;
}) {
  const pathname = usePathname();
  const { collapsed, toggleCollapsed, closeDrawer } = useShell();

  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        <Link href="/home" className="sidebar-brand" onClick={closeDrawer}>
          <LogoMark size={34} />
          <span className="sidebar-wordmark font-display font-semibold">Hale</span>
        </Link>

        <div className="sidebar-top-controls">
          <button
            type="button"
            onClick={toggleCollapsed}
            className="sidebar-collapse"
            aria-expanded={!collapsed}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            <Icon as={collapsed ? PanelLeftOpen : PanelLeftClose} size={18} />
          </button>
          <button
            type="button"
            onClick={closeDrawer}
            className="sidebar-drawer-close"
            aria-label="Close menu"
          >
            <Icon as={X} size={20} />
          </button>
        </div>
      </div>

      <span className="sidebar-tagline meta">the village your family lost</span>

      <nav className="sidebar-nav" aria-label="primary">
        {NAV.map((item) => (
          <NavLink
            key={item.href}
            href={item.href}
            label={item.label}
            icon={item.icon}
            active={pathname === item.href || pathname?.startsWith(`${item.href}/`)}
            onNavigate={closeDrawer}
          />
        ))}
      </nav>

      {/* History — the audit trail, kept quiet at the foot, not a primary stop. */}
      <div className="sidebar-foot">
        <div className="rule" />
        <NavLink
          href={'/trail' as Route}
          label="history"
          icon={History}
          active={pathname === '/trail' || Boolean(pathname?.startsWith('/trail/'))}
          onNavigate={closeDrawer}
        />

        <div className="sidebar-foot-controls">
          <ThemeToggle />
          {authControls ? (
            signedIn ? (
              <form action={signOutAction}>
                <button type="submit" className="btn-ghost">
                  sign out
                </button>
              </form>
            ) : (
              <Link href="/sign-in" className="btn-primary" onClick={closeDrawer}>
                sign in
              </Link>
            )
          ) : null}
        </div>

        {/* The one tasteful sea turtle — Hale, resting at the foot. */}
        <div className="sidebar-turtle" aria-hidden>
          <SeaTurtle age="hatchling" style={{ height: 44, width: 'auto' }} />
          <span className="meta">here for your family</span>
        </div>
      </div>
    </aside>
  );
}
