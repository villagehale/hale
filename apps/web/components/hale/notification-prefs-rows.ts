import type { PushPref } from '~/lib/settings/push-notification-prefs';

/**
 * The Notifications rows, kept free of the server action + 'use client' so they can
 * be unit-tested directly (mirrors how quick-log-kinds is split from quick-log).
 * `pref: PushPref` ties each row to a real persisted notification_prefs boolean at
 * compile time — a fabricated stream (one the store can't back) is a type error,
 * not a shipped lie (rule #1).
 *
 * A persisted column is necessary but NOT sufficient for a row to exist here: the
 * stream also has to actually be SENT. `pushHealthReminders` was dropped for exactly
 * that reason — its sender (/api/cron/push-reminders) is not in vercel.json's cron
 * list, so nothing ever triggers it and the switch governed nothing. The column and
 * the send path are left in place; only the control a parent could believe in is
 * gone. `pushNewPicks` stays because /api/cron/discovery really does send it weekly.
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
];
