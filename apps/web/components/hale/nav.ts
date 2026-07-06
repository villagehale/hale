import type { Route } from 'next';
import {
  CalendarRange,
  CheckCircle2,
  History,
  House,
  MessageCircleHeart,
  Settings,
  Sparkles,
  Users,
  UsersRound,
} from 'lucide-react';

/**
 * The single source of truth for the app's navigation, imported by BOTH the
 * sidebar and the top header so the two can never disagree on the route list or
 * its labels. `PRIMARY_NAV` is the daily product surfaces. History (the audit
 * trail) and Settings (configuration) are kept separate: the sidebar files both
 * quietly at the foot, near the user, rather than alongside the primary stops —
 * the header still finds them via `ALL_NAV` for the eyebrow.
 */

export interface NavItem {
  href: Route;
  label: string;
  icon: typeof House;
}

export const PRIMARY_NAV = [
  { href: '/home', label: 'home', icon: House },
  { href: '/approvals', label: 'approvals', icon: CheckCircle2 },
  { href: '/coach', label: 'concierge', icon: MessageCircleHeart },
  { href: '/companion', label: 'companion', icon: Sparkles },
  { href: '/village', label: 'village', icon: Users },
  { href: '/plan', label: 'plan', icon: CalendarRange },
  { href: '/family', label: 'family', icon: UsersRound },
] as const satisfies ReadonlyArray<NavItem>;

export const HISTORY_NAV = {
  href: '/trail',
  label: 'history',
  icon: History,
} as const satisfies NavItem;

export const SETTINGS_NAV = {
  href: '/settings',
  label: 'settings',
  icon: Settings,
} as const satisfies NavItem;

export const ALL_NAV = [
  ...PRIMARY_NAV,
  HISTORY_NAV,
  SETTINGS_NAV,
] as const satisfies ReadonlyArray<NavItem>;
