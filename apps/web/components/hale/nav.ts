import { History, House, MessageSquare, Settings, UsersRound } from 'lucide-react';
import type { Route } from 'next';

/**
 * The receipts-room stops. The parent portal is Home, Messages, Family, and
 * Settings. Approvals, the trail, and the week still render by URL.
 */

export interface NavItem {
  href: Route;
  label: string;
  icon: typeof House;
}

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

export const RECEIPTS_NAV = [
  { href: '/home', label: 'Home', icon: House },
  { href: '/messages', label: 'Messages', icon: MessageSquare },
  { href: '/family', label: 'Family', icon: UsersRound },
  { href: '/settings', label: 'Settings', icon: Settings },
] as const satisfies ReadonlyArray<NavItem>;

/** The portal's stops. The receipts room is the only IA. */
export function primaryNav(): ReadonlyArray<NavItem> {
  return RECEIPTS_NAV;
}
