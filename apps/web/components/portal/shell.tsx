'use client';

import { ChevronLeft } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { Wordmark } from '~/components/hale/connect/wordmark';
import { type RootHero, type RootRoute, resolveHero } from '~/components/hale/hero-map';
import { navWithAdmin, primaryNav } from '~/components/hale/nav';
import { signOutAction } from '~/lib/auth-actions';
import { PRIVACY_URL } from '~/lib/legal-links';
import { portalOwnsHeading } from './owns-heading';
import styles from './portal.module.css';

const FOOTER_LEAD = 'Never sold.';
const FOOTER_PRIVACY = 'Privacy policy';
const PRONUNCIATION = 'Hale /HAH-leh/ — Hawaiian for home.';

function onRoute(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * Frosted portal frame: coastal shore, glass sidebar on desktop, frosted tab
 * bar on a phone. Sign out is pinned in the sidebar; on a phone it lives in
 * Settings. The active pill is glass — no navy bar.
 */
export function PortalShell({
  children,
  showAdmin,
  canSignOut,
  roots,
}: {
  children: ReactNode;
  showAdmin: boolean;
  canSignOut: boolean;
  roots: Record<RootRoute, RootHero>;
}) {
  const pathname = usePathname() ?? '/home';
  const stops = navWithAdmin(primaryNav(true), showAdmin);
  const tabs = primaryNav(true);

  return (
    <div className={styles.shell}>
      <aside className={styles.side} aria-label="Portal">
        <Link href="/home" className={styles.brand} aria-label="Hale, home">
          <img className={styles.logo} src="/connect/hale-logo.jpeg" alt="" />
          <Wordmark className={styles.wordmark} />
        </Link>
        <nav className={styles.sidenav} aria-label="Sections">
          {stops.map((item) => {
            const Icon = item.icon;
            const on = onRoute(pathname, item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={on ? `${styles.navLink} ${styles.navOn}` : styles.navLink}
                aria-current={on ? 'page' : undefined}
              >
                <Icon aria-hidden="true" strokeWidth={on ? 1.9 : 1.75} />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>
        {canSignOut ? (
          <form action={signOutAction}>
            <button type="submit" className={styles.signout}>
              <SignOutIcon />
              <span>Sign out</span>
            </button>
          </form>
        ) : null}
      </aside>
      <div className={styles.content}>
        <img
          className={styles.shore}
          src="/connect/hale-shore-hero.webp"
          alt=""
          aria-hidden="true"
        />
        <span className={styles.drift} aria-hidden="true" />
        <span className={styles.scrim} aria-hidden="true" />
        <main id="main-content" className={styles.main}>
          <FallbackHero roots={roots} />
          {children}
        </main>
        <footer className={styles.foot}>
          <span>
            {FOOTER_LEAD} <a href={PRIVACY_URL}>{FOOTER_PRIVACY}</a>
          </span>
          <span>{PRONUNCIATION}</span>
        </footer>
      </div>
      <nav className={styles.tabbar} aria-label="Sections">
        {tabs.map((item) => {
          const Icon = item.icon;
          const on = onRoute(pathname, item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={on ? `${styles.tab} ${styles.tabOn}` : styles.tab}
              aria-current={on ? 'page' : undefined}
            >
              <Icon aria-hidden="true" strokeWidth={on ? 1.9 : 1.75} />
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>
    </div>
  );
}

function FallbackHero({ roots }: { roots: Record<RootRoute, RootHero> }) {
  const pathname = usePathname() ?? '';
  if (portalOwnsHeading(pathname)) return null;
  const resolved = resolveHero(pathname, roots, true);
  if (!resolved) return null;
  if (resolved.kind === 'drill') {
    const { crumb, title, backHref } = resolved.hero;
    return (
      <div className={styles.fallback}>
        <Link href={backHref} className={styles.crumb}>
          <ChevronLeft aria-hidden="true" />
          {crumb}
        </Link>
        <h1 className={styles.h1}>{title}</h1>
      </div>
    );
  }
  const { title, subtitle, emoji } = resolved.hero;
  return (
    <div className={styles.fallback}>
      <h1 className={styles.h1} data-hale-pii>
        {title}
        {emoji ? (
          <>
            {' '}
            <span aria-hidden="true">{emoji}</span>
          </>
        ) : null}
      </h1>
      <p className={styles.lede} data-hale-pii>
        {subtitle}
      </p>
    </div>
  );
}

function SignOutIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      aria-hidden="true"
    >
      <path d="M9 6H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h3" strokeLinecap="round" />
      <path d="M13 16l4-4-4-4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M17 12H9" strokeLinecap="round" />
    </svg>
  );
}
