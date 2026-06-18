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
  Sparkles,
  Users,
} from 'lucide-react';
import { SeaTurtle } from '~/components/illos';
import { Icon } from '~/components/ui/icon';
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

export function Sidebar({
  authControls = false,
  signedIn = false,
}: {
  authControls?: boolean;
  signedIn?: boolean;
}) {
  const pathname = usePathname();

  return (
    <aside className="sidebar">
      <div>
        <Link href="/home" className="flex items-center gap-3">
          <LogoMark size={34} />
          <span className="font-display text-[2.1rem] leading-none font-semibold">Hale</span>
        </Link>
        <span className="meta block mt-2">the village your family lost</span>

        <div className="mt-4 flex items-center justify-end gap-3">
          <ThemeToggle />
        </div>

        {authControls ? (
          <div className="mt-6 flex items-center gap-4">
            {signedIn ? (
              <form action={signOutAction}>
                <button type="submit" className="btn-ghost">
                  sign out
                </button>
              </form>
            ) : (
              <Link href="/sign-in" className="btn-primary">
                sign in
              </Link>
            )}
          </div>
        ) : null}
      </div>

      <nav className="mt-10 space-y-0.5">
        {NAV.map((item) => {
          const active = pathname === item.href || pathname?.startsWith(`${item.href}/`);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? 'page' : undefined}
              className="nav-item"
            >
              <span className="nav-folio">
                <Icon as={item.icon} size={18} />
              </span>
              <span className="nav-label">{item.label}</span>
            </Link>
          );
        })}
      </nav>

      {/* History — the audit trail, kept quiet at the foot, not a primary stop. */}
      <div className="mt-auto pt-10 space-y-4">
        <div className="rule" />
        <Link href="/trail" className="nav-item">
          <span className="nav-folio">
            <Icon as={History} size={18} />
          </span>
          <span className="nav-label">history</span>
        </Link>

        {/* The one tasteful sea turtle — Hale, resting at the foot. */}
        <div className="pt-2 flex items-end gap-3" aria-hidden>
          <SeaTurtle age="hatchling" style={{ height: 44, width: 'auto' }} />
          <span className="meta">here for your family</span>
        </div>
      </div>
    </aside>
  );
}
