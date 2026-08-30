import type { Route } from 'next';
import {
  ListChecks,
  CalendarDays,
  History,
  House,
  MessageSquare,
  Settings,
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
 * Hale did and decide what's next": Home is the decision queue (/approvals — the full
 * record hangs off its foot), Family is the household editor, Settings is the dials.
 * A stop has to earn its place as a receipt or as a control that cannot live in a
 * text; the trail, the week and the village render but are not stops (DEMOTED_NAV).
 */
export const RECEIPTS_NAV = [
  { href: '/family', label: 'Family', icon: UsersRound },
  { href: '/approvals', label: 'Approvals', icon: ListChecks },
  { href: '/settings', label: 'Settings', icon: Settings },
] as const satisfies ReadonlyArray<NavItem>;

/**
 * Reachable by direct URL, but no longer a nav destination. These are LABELS ONLY —
 * neither the sidebar nor the drawer renders them. They exist so the running-head
 * eyebrow can still name the page a parent is looking at: a demoted route still
 * RENDERS (unlike a retired one, which permanently redirects), and a page with no
 * label loses its eyebrow.
 */
export const DEMOTED_NAV = [
  { href: '/trail', label: 'Trail', icon: History },
  { href: '/messages', label: 'Messages', icon: MessageSquare },
  { href: '/plan', label: 'Week', icon: CalendarDays },
  { href: '/village', label: 'Village', icon: Users },
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
 * the reframe on, `/home` is a 302 to `/approvals`, so pointing the brand there would
 * make every logo click pay a redirect hop to reach the landing surface. Keeping this
 * equal to the middleware's forward target is what receipts-ia.test.ts asserts.
 */
export function brandHref(receiptsIa: boolean): Route {
  return receiptsIa ? '/family' : '/home';
}

/**
 * The label table the running-head eyebrow resolves the current route against: the
 * stops for the resolved flag lead (so a shared route reads its own label), then the
 * demoted-but-still-reachable routes follow so their pages keep an eyebrow.
 */
export function allNav(receiptsIa: boolean): ReadonlyArray<NavItem> {
  const stops = receiptsIa ? RECEIPTS_NAV : ALL_NAV;
  const seen = new Set<string>(stops.map((item) => item.href));
  return [...stops, ...DEMOTED_NAV.filter((item) => !seen.has(item.href))];
}
