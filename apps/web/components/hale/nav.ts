import type { Route } from 'next';
import {
  CalendarDays,
  ClipboardCheck,
  History,
  House,
  Settings,
  Sparkles,
  User,
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
  { href: '/home', label: 'Home', icon: House },
  { href: '/companion', label: 'Companion', icon: User },
  { href: '/coach', label: 'Ask', icon: Sparkles },
  { href: '/village', label: 'Village', icon: Users },
  { href: '/family', label: 'Family', icon: UsersRound },
] as const satisfies ReadonlyArray<NavItem>;

export const HISTORY_NAV = {
  href: '/trail',
  label: 'history',
  icon: History,
} as const satisfies NavItem;

export const SETTINGS_NAV = {
  href: '/settings',
  label: 'account',
  icon: Settings,
} as const satisfies NavItem;

export const ALL_NAV = [
  ...PRIMARY_NAV,
  SETTINGS_NAV,
] as const satisfies ReadonlyArray<NavItem>;

/**
 * VIL-244 · M9 — the receipts-room stops (D4/D20), behind F14_RECEIPTS_IA. The app's
 * job stops being "a place to read a daily feed" and becomes "the place you check what
 * Hale did and decide what's next": the decision queue, the week, the record, the
 * village, the dials. The daily feed and the Ask chat are not stops — both routes stay
 * reachable by direct URL (their removal is a later PR).
 */
export const RECEIPTS_NAV = [
  { href: '/approvals', label: 'Approvals', icon: ClipboardCheck },
  { href: '/plan', label: 'Week', icon: CalendarDays },
  { href: '/trail', label: 'Trail', icon: History },
  { href: '/village', label: 'Village', icon: Users },
  { href: '/settings', label: 'Settings', icon: Settings },
] as const satisfies ReadonlyArray<NavItem>;

/**
 * The sidebar's stops for the resolved flag. Pure and env-free by construction: the IA
 * flag is a server-read variable (no NEXT_PUBLIC_ prefix), so the authed layout resolves
 * it once and hands the boolean down. Reading it here — in a module the client bundle
 * pulls in — would resolve to undefined in the browser and desync the two renders.
 */
export function primaryNav(receiptsIa: boolean): ReadonlyArray<NavItem> {
  return receiptsIa ? RECEIPTS_NAV : PRIMARY_NAV;
}

/**
 * Where the brand mark goes. It has to follow the same demotion the nav does: with
 * the reframe on, `/home` is a 302 to `/plan`, so pointing the brand there would
 * make every logo click pay a redirect hop to reach the landing surface.
 */
export function brandHref(receiptsIa: boolean): Route {
  return receiptsIa ? '/plan' : '/home';
}

/**
 * The label table the running-head eyebrow resolves the current route against. Under
 * the reframe the five stops lead (so a shared route reads its receipts label), then
 * the demoted-but-still-reachable routes follow so their pages keep an eyebrow.
 */
export function allNav(receiptsIa: boolean): ReadonlyArray<NavItem> {
  if (!receiptsIa) return ALL_NAV;
  const stops = new Set<string>(RECEIPTS_NAV.map((item) => item.href));
  return [...RECEIPTS_NAV, ...ALL_NAV.filter((item) => !stops.has(item.href))];
}
