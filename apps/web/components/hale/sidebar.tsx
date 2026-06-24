'use client';

import type { Route } from 'next';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LogIn,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
  X,
  type Home as HomeIcon,
} from 'lucide-react';
import { Icon } from '~/components/ui/icon';
import { useShell } from '~/components/hale/app-shell';
import { LogoMark } from '~/components/hale/logo-mark';
import { HISTORY_NAV, PRIMARY_NAV, SETTINGS_NAV } from '~/components/hale/nav';
import { signOutAction } from '~/lib/auth-actions';

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
        {PRIMARY_NAV.map((item) => (
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

      {/* The user area: History (the audit trail) and Settings (configuration)
       * sit quietly at the foot, near sign-out — not as primary stops. Settings
       * is filed here by the user, the modern-app pattern, never a top-nav peer. */}
      <div className="sidebar-foot">
        <div className="rule" />
        <NavLink
          href={HISTORY_NAV.href}
          label={HISTORY_NAV.label}
          icon={HISTORY_NAV.icon}
          active={
            pathname === HISTORY_NAV.href ||
            Boolean(pathname?.startsWith(`${HISTORY_NAV.href}/`))
          }
          onNavigate={closeDrawer}
        />
        <NavLink
          href={SETTINGS_NAV.href}
          label={SETTINGS_NAV.label}
          icon={SETTINGS_NAV.icon}
          active={
            pathname === SETTINGS_NAV.href ||
            Boolean(pathname?.startsWith(`${SETTINGS_NAV.href}/`))
          }
          onNavigate={closeDrawer}
        />

        <div className="sidebar-foot-controls">
          {authControls ? (
            signedIn ? (
              <form action={signOutAction}>
                <button type="submit" className="btn-ghost auth-control" title="sign out">
                  <Icon as={LogOut} size={18} className="auth-control-icon" />
                  <span className="nav-label">sign out</span>
                </button>
              </form>
            ) : (
              <Link
                href="/sign-in"
                className="btn-primary auth-control"
                onClick={closeDrawer}
                title="sign in"
              >
                <Icon as={LogIn} size={18} className="auth-control-icon" />
                <span className="nav-label">sign in</span>
              </Link>
            )
          ) : null}
        </div>
      </div>
    </aside>
  );
}
