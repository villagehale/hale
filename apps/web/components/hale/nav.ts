import type { Route } from 'next';
import {
  CalendarRange,
  History,
  House,
  Home as HomeIcon,
  MessageCircleHeart,
  Sparkles,
  Users,
} from 'lucide-react';

/**
 * The single source of truth for the app's navigation, imported by BOTH the
 * sidebar and the top header so the two can never disagree on the route list or
 * its labels. `PRIMARY_NAV` is the main stops; History (the audit trail) is kept
 * separate because the sidebar files it quietly at the foot rather than alongside
 * the primary stops — the header still finds it via `ALL_NAV` for the eyebrow.
 */

export interface NavItem {
  href: Route;
  label: string;
  icon: typeof HomeIcon;
}

export const PRIMARY_NAV = [
  { href: '/home', label: 'home', icon: HomeIcon },
  { href: '/coach', label: 'ask Hale', icon: MessageCircleHeart },
  { href: '/companion', label: 'companion', icon: Sparkles },
  { href: '/village', label: 'village', icon: Users },
  { href: '/plan', label: 'plan', icon: CalendarRange },
  { href: '/settings', label: 'family', icon: House },
] as const satisfies ReadonlyArray<NavItem>;

export const HISTORY_NAV = {
  href: '/trail',
  label: 'history',
  icon: History,
} as const satisfies NavItem;

export const ALL_NAV = [...PRIMARY_NAV, HISTORY_NAV] as const satisfies ReadonlyArray<NavItem>;
