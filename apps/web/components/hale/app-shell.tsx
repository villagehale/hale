'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { SHELL_COLLAPSED_KEY } from '~/lib/shell';

type ShellContextValue = {
  collapsed: boolean;
  toggleCollapsed: () => void;
  drawerOpen: boolean;
  openDrawer: () => void;
  closeDrawer: () => void;
};

const ShellContext = createContext<ShellContextValue | null>(null);

export function useShell(): ShellContextValue {
  const value = useContext(ShellContext);
  if (!value) throw new Error('useShell must be used within <AppShell>');
  return value;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])';

export function AppShell({
  sidebar,
  header,
  children,
}: {
  sidebar: React.ReactNode;
  header: React.ReactNode;
  children: React.ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const pathname = usePathname();
  const drawerRef = useRef<HTMLDivElement>(null);

  // The pre-paint script already set the html attribute (and thus the rendered
  // width) from storage; mirror it into state so the toggle's icon/aria match.
  useEffect(() => {
    setCollapsed(document.documentElement.dataset.shellCollapsed === '1');
  }, []);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem(SHELL_COLLAPSED_KEY, next ? '1' : '0');
      document.documentElement.dataset.shellCollapsed = next ? '1' : '0';
      return next;
    });
  }, []);

  const openDrawer = useCallback(() => setDrawerOpen(true), []);
  const closeDrawer = useCallback(() => setDrawerOpen(false), []);

  // Close the drawer whenever the route changes — covers back/forward and
  // programmatic redirects that the per-link onClick handlers don't catch.
  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname is the intended trigger, not a value read in the body
  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!drawerOpen) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setDrawerOpen(false);
        return;
      }
      if (event.key !== 'Tab') return;
      const panel = drawerRef.current;
      if (!panel) return;
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    document.body.style.overflow = 'hidden';
    drawerRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = '';
    };
  }, [drawerOpen]);

  return (
    <ShellContext.Provider
      value={{ collapsed, toggleCollapsed, drawerOpen, openDrawer, closeDrawer }}
    >
      <div className="editorial-layout">
        <button
          type="button"
          className="drawer-scrim"
          data-open={drawerOpen ? '' : undefined}
          onClick={closeDrawer}
          tabIndex={-1}
          aria-label="Close menu"
        />
        <div ref={drawerRef} className="sidebar-dock" data-open={drawerOpen ? '' : undefined}>
          {sidebar}
        </div>
        <div className="shell-column">
          {header}
          {children}
        </div>
      </div>
    </ShellContext.Provider>
  );
}
