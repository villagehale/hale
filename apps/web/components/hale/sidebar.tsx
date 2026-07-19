'use client';

import type { Route } from 'next';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LogIn,
  PanelLeftClose,
  PanelLeftOpen,
  X,
  type House as HouseIcon,
} from 'lucide-react';
import { Icon } from '~/components/ui/icon';
import { AccountMenu } from '~/components/hale/account-menu';
import { useShell } from '~/components/hale/app-shell';
import { ChildSwitcher } from '~/components/hale/child-switcher';
import type { SwitcherChild } from '~/components/hale/child-switcher-view';
import { LogoMark } from '~/components/hale/logo-mark';
import { PRIMARY_NAV } from '~/components/hale/nav';

function NavLink({
  href,
  label,
  icon,
  active,
  onNavigate,
}: {
  href: Route;
  label: string;
  icon: typeof HouseIcon;
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
  parentName = null,
  kids = [],
}: {
  authControls?: boolean;
  signedIn?: boolean;
  parentName?: string | null;
  /** The family's children, for the foot child switcher. */
  kids?: SwitcherChild[];
}) {
  const pathname = usePathname();
  const { collapsed, toggleCollapsed, closeDrawer } = useShell();

  // The account chip stands in for a real identity: a live session, or the
  // dev-preview family (auth off). The signed-out-with-auth case shows sign-in.
  const showAccount = signedIn || !authControls;

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

      {/* The foot cluster (design handoff §3.1): a child switcher, a divider, then
       * the account chip. The chip's menu holds Settings + Appearance and — below a
       * divider — Sign out, an account action. The signed-out-with-auth case shows a
       * plain sign-in instead. */}
      <div className="sidebar-foot">
        {showAccount ? (
          <>
            <ChildSwitcher kids={kids} />
            <div className="rule" />
            <AccountMenu
              parentName={parentName}
              canSignOut={authControls && signedIn}
            />
          </>
        ) : (
          <>
            <div className="rule" />
            <div className="sidebar-foot-controls">
              <Link
                href="/sign-in"
                className="btn-primary auth-control"
                onClick={closeDrawer}
                title="sign in"
              >
                <Icon as={LogIn} size={18} className="auth-control-icon" />
                <span className="nav-label">sign in</span>
              </Link>
            </div>
          </>
        )}
      </div>
    </aside>
  );
}
