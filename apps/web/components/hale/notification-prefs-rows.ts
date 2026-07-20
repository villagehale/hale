import type { PushPref } from '~/lib/settings/push-notification-prefs';

/**
 * The two Notifications rows, kept free of the server action + 'use client' so
 * they can be unit-tested directly (mirrors how quick-log-kinds is split from
 * quick-log). `pref: PushPref` ties each row to a real persisted notification_prefs
 * boolean at compile time — a fabricated stream (one the store can't back) is a
 * type error, not a shipped lie (rule #1).
 */
export interface PushPrefRow {
  pref: PushPref;
  label: string;
  description: string;
}

export const PUSH_PREF_ROWS: PushPrefRow[] = [
  {
    pref: 'pushNewPicks',
    label: 'New local picks',
    description: 'When a family near you shares a place worth knowing about.',
  },
  {
    pref: 'pushHealthReminders',
    label: 'Health reminders',
    description: 'Gentle nudges for check-ups and immunizations, on the Canadian schedule.',
  },
];
