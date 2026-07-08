import { type Database, schema } from '@hale/db';
import { and, eq, gte } from 'drizzle-orm';

/**
 * The push-notification preferences behind Settings, plus the once-per-family-
 * per-day debounce ledger the send callers check. Two streams a parent controls —
 * new village picks and health reminders — both default ON: a push is a
 * transactional, in-app family signal (not CASL commercial email), so the absence
 * of a notification_prefs row means "both on" (the default view). The daily brief
 * EMAIL stays on its own opt-out model (email_opt_outs) and is NOT modelled here.
 *
 * Privacy (rule #1): nothing here carries child content — only the parent's two
 * boolean choices and, in the ledger, a coarse stream label + send time.
 */

/** The two push streams a parent controls. */
export type PushKind = 'new_picks' | 'health_reminder';

export interface PushPrefsView {
  pushNewPicks: boolean;
  pushHealthReminders: boolean;
}

/** The never-touched default: both push streams on. */
const DEFAULT_VIEW: PushPrefsView = { pushNewPicks: true, pushHealthReminders: true };

/**
 * The user's push preferences, or the default (both on) when no row exists. The
 * row's ABSENCE is a valid state — a parent who never opened Settings still
 * receives both streams — so a missing row is the default, not an error.
 */
export async function loadPushPrefsView(
  userId: string,
  database: Database,
): Promise<PushPrefsView> {
  const rows = await database
    .select({
      pushNewPicks: schema.notificationPrefs.pushNewPicks,
      pushHealthReminders: schema.notificationPrefs.pushHealthReminders,
    })
    .from(schema.notificationPrefs)
    .where(eq(schema.notificationPrefs.userId, userId))
    .limit(1);
  const row = rows[0];
  return row ?? DEFAULT_VIEW;
}

/** True when the user has this push stream enabled (default on when untouched). */
export async function pushEnabledFor(
  userId: string,
  kind: PushKind,
  database: Database,
): Promise<boolean> {
  const view = await loadPushPrefsView(userId, database);
  return kind === 'new_picks' ? view.pushNewPicks : view.pushHealthReminders;
}

/**
 * Start of the CURRENT day in America/Toronto, as a Date — the debounce window
 * boundary. The crons run in the morning Toronto time, so "once per day" is anchored
 * to the local day, not UTC midnight.
 */
export function startOfTorontoDay(now: Date): Date {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Toronto',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZoneName: 'longOffset',
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  // Derive the offset from the zone itself (GMT-05:00 in winter, GMT-04:00 in
  // summer) so midnight Toronto resolves correctly across the DST boundary — a
  // hardcoded offset would be a half-year bug.
  const offset = get('timeZoneName').replace('GMT', '') || '-05:00';
  return new Date(`${get('year')}-${get('month')}-${get('day')}T00:00:00${offset}`);
}

/**
 * The once-per-family-per-day guard: has this family already received a push of
 * this kind since the start of the Toronto day? Checked against the push_sends
 * ledger before addressing any device, so a family gets at most one push per kind
 * per day even if the cron/drain runs many times.
 */
export async function sentPushToFamilyToday(
  database: Database,
  familyId: string,
  kind: PushKind,
  now: Date = new Date(),
): Promise<boolean> {
  const rows = await database
    .select({ id: schema.pushSends.id })
    .from(schema.pushSends)
    .where(
      and(
        eq(schema.pushSends.familyId, familyId),
        eq(schema.pushSends.kind, kind),
        gte(schema.pushSends.sentAt, startOfTorontoDay(now)),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** Records one fired push in the family debounce ledger (rule #1: no child content —
 * only the family id + coarse stream label + send time). */
export async function recordFamilyPushSent(
  database: Database,
  familyId: string,
  kind: PushKind,
): Promise<void> {
  await database.insert(schema.pushSends).values({ familyId, kind });
}
