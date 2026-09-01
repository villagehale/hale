'use client';

import type { Route } from 'next';
import { motion, useReducedMotion } from 'motion/react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';

/**
 * The tab bar — one question per tab, in the dial's own anatomy scaled up
 * (wash track, amber thumb). Real routes, so every tab is deep-linkable by
 * construction; each href carries the current `?w=` forward so the dial's
 * window survives navigation.
 */
export const ADMIN_TABS = [
  { href: '/admin', label: 'Overview' },
  { href: '/admin/engagement', label: 'Engagement' },
  { href: '/admin/funnels', label: 'Funnels' },
  { href: '/admin/operations', label: 'Operations' },
  { href: '/admin/agents', label: 'Agents' },
  { href: '/admin/radar', label: 'Radar' },
  { href: '/admin/ledger', label: 'Ledger' },
] as const;

/** Pure: the href a tab navigates to, keeping the dial's `?w=` when present. */
export function tabHref(href: string, w: string | null): string {
  return w === null ? href : `${href}?w=${encodeURIComponent(w)}`;
}

/** Pure: Overview is exact-match only (every other tab sits under /admin/). */
export function isActiveTab(href: string, pathname: string | null): boolean {
  if (href === '/admin') return pathname === '/admin';
  return pathname === href || Boolean(pathname?.startsWith(`${href}/`));
}

export function AdminTabs() {
  const pathname = usePathname();
  const w = useSearchParams().get('w');
  const reduced = useReducedMotion();

  return (
    <nav className="adm-tabs" aria-label="Admin sections">
      {ADMIN_TABS.map((tab) => {
        const active = isActiveTab(tab.href, pathname);
        return (
          <Link
            key={tab.href}
            href={tabHref(tab.href, w) as Route}
            aria-current={active ? 'page' : undefined}
            className="adm-tab"
          >
            {active ? (
              <motion.span
                layoutId="adm-tab-thumb"
                className="adm-tab-thumb"
                transition={
                  reduced ? { duration: 0 } : { type: 'spring', stiffness: 500, damping: 40 }
                }
              />
            ) : null}
            <span className="adm-tab-label">{tab.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
