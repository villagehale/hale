import { type Database, schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { PROACTIVE_QUIET_HOURS } from '~/lib/channel/outbound-gate';
import { DEFAULT_TIMEZONE } from '~/lib/format/datetime';
import { localParts } from '~/lib/loop/prefs';

/**
 * THE ONE RE-DRIVE MECHANISM — the morning slot every message quiet hours held comes
 * back in.
 *
 * `PROACTIVE_QUIET_HOURS` is a floor, not a filter: a message it refuses at 23:00 is
 * DEFERRED, and a deferral nothing resumes is a drop wearing a receipt. Two sends now
 * depend on being resumed — the intake contact card (welcome-card-redrive.ts) and the
 * co-parent departure notice (coparent/departure-redrive.ts) — and they resume on the
 * SAME hourly cron leg, at the SAME local hour, with the same per-run cap and the same
 * staleness bound. This module is why that is one mechanism rather than two that happen
 * to agree today.
 *
 * Each sweep still owns the two things that are genuinely its own: WHAT is still owed
 * (a held receipt for the card; the departure fact itself for the notice) and WHICH
 * function sends it. Nothing else differs, and nothing else should.
 */

/**
 * The local hour a held message goes out in — the hour the quiet window ENDS, read off
 * {@link PROACTIVE_QUIET_HOURS} rather than typed again, so a change to the floor moves
 * every re-drive with it.
 *
 * The cron fires hourly, so this matches the whole HOUR (the house rule: an exact-minute
 * match silently drops every family whose tick landed a minute late — nudge/run.ts).
 */
export const REDRIVE_HOUR_LOCAL = Number(PROACTIVE_QUIET_HOURS.end.slice(0, 2));

/** Whether `now` sits in this parent's re-drive hour, on their OWN clock. */
export function isRedriveSlot(now: Date, timeZone: string): boolean {
  return Math.floor(localParts(now, timeZone).minutes / 60) === REDRIVE_HOUR_LOCAL;
}

/**
 * How stale a held message may be and still be worth sending.
 *
 * Two reasons, and both land on the same week. A message stops being the message it was:
 * a vCard arriving a fortnight after the conversation is a stranger's number texting a
 * contact card out of nowhere, and a departure notice arriving then is news the parent
 * found out some other way days ago. It also BOUNDS THE SCAN — without it, every family
 * a sweep can never serve (no number, revoked channel, no consent) is re-read on every
 * tick for the life of the product.
 */
export const REDRIVE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How many held messages one tick will send, so an hourly cron leg cannot turn into a
 * hundreds-of-text run. The overflow is DEFERRED, not dropped: each sweep counts it,
 * logs it, still owes it, and reads oldest-first so the families a cap leaves behind are
 * the ones who have waited least.
 */
export const MAX_REDRIVE_PER_RUN = 100;

/** The parent's wall clock, off their own users row. */
export async function redriveParentTimeZone(
  database: Database,
  parentUserId: string,
): Promise<string> {
  const rows = await database
    .select({ id: schema.users.id, timezone: schema.users.timezone })
    .from(schema.users)
    .where(eq(schema.users.id, parentUserId));
  return rows.find((row) => row.id === parentUserId)?.timezone ?? DEFAULT_TIMEZONE;
}
