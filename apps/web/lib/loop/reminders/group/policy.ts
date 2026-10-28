import { isWithinQuietHours } from '~/lib/loop/prefs';
import { addDaysToKey, dayKeyIn, zonedLocalInstant } from '~/lib/plan/spine';

/**
 * VIL-448 (T26) — the rules a group reminder follows, with no I/O.
 *
 * The model reads the ask (who it is for, what, when as the person said it). Code decides
 * everything that is a rule: the exact instant, where it is delivered, how quiet hours
 * move it, and whether a due reminder may still go out.
 */

export type ReminderFor = 'sender' | 'person' | 'everyone';
export type ReminderWhere = 'group' | 'private' | 'unsaid';
export type ReminderDelivery = 'group' | 'direct';
export type QuietShift = 'earlier' | 'later' | null;

/** One reminder as the reader returned it. */
export interface ReminderAsk {
  for: ReminderFor;
  name: string | null;
  what: string;
  date: string | null;
  time: string | null;
  inMinutes: number | null;
  where: ReminderWhere;
}

/** A local quiet stretch, `HH:MM` or `HH:MM:SS`. Start after end wraps midnight. */
export interface QuietWindow {
  start: string;
  end: string;
}

/** Nothing is set for sooner than this: the confirmation has to land first. */
export const MIN_LEAD_MS = 2 * 60_000;
export const MAX_HORIZON_DAYS = 120;
/** A reminder moved earlier for quiet hours goes this long before the stretch opens. */
export const QUIET_EARLY_MARGIN_MS = 15 * 60_000;
/** A due reminder later than this is dropped as missed, never sent stale. */
export const LATE_LIMIT_MS = 2 * 60 * 60_000;
/** The quiet window's end for a group post (quiet.ts: the gate's 08:00). */
export const QUIET_END = '08:00';
export const MAX_WHAT_CHARS = 300;

const MINUTE_MS = 60_000;
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

function floorToMinute(ms: number): number {
  return Math.floor(ms / MINUTE_MS) * MINUTE_MS;
}

/** The reader's `what`, tidied; null when there is nothing usable to remind about. */
export function cleanWhat(what: string): string | null {
  const text = what.replace(/\s+/g, ' ').trim();
  if (text === '' || text.length > MAX_WHAT_CHARS) return null;
  return text;
}

/**
 * The instant the person asked for, or null when the ask has no usable time: no time at
 * all, a malformed one, one already past, or one beyond the horizon. A bare clock time
 * within `MIN_LEAD_MS` of now is null too: it means now, which is too soon to set, not
 * the same time tomorrow. Null is a question back to them ("when?"), never a guess.
 */
export function askedInstant(ask: ReminderAsk, now: Date, timeZone: string): Date | null {
  const earliest = now.getTime() + MIN_LEAD_MS;
  const latest = now.getTime() + MAX_HORIZON_DAYS * 24 * 60 * MINUTE_MS;
  let at: Date;
  if (ask.inMinutes !== null) {
    if (!Number.isInteger(ask.inMinutes) || ask.inMinutes < 1) return null;
    at = new Date(floorToMinute(now.getTime() + ask.inMinutes * MINUTE_MS));
  } else {
    if (ask.time === null || !CLOCK.test(ask.time)) return null;
    if (ask.date !== null) {
      if (!DAY_KEY.test(ask.date)) return null;
      try {
        at = zonedLocalInstant(ask.date, ask.time, timeZone);
      } catch {
        return null;
      }
    } else {
      const today = dayKeyIn(now, timeZone);
      const sameDay = zonedLocalInstant(today, ask.time, timeZone);
      if (Math.abs(sameDay.getTime() - now.getTime()) < MIN_LEAD_MS) return null;
      at =
        sameDay.getTime() >= earliest
          ? sameDay
          : zonedLocalInstant(addDaysToKey(today, 1), ask.time, timeZone);
    }
  }
  if (Number.isNaN(at.getTime()) || at.getTime() < earliest || at.getTime() > latest) return null;
  return at;
}

export function inQuiet(at: Date, timeZone: string, windows: readonly QuietWindow[]): boolean {
  return windows.some((w) => isWithinQuietHours(at, timeZone, w.start, w.end));
}

/**
 * The edge of the quiet stretch `at` sits in: its first quiet minute (`-1`) or the first
 * minute after it (`+1`). Walks in five-minute steps, then settles on the minute. Null
 * when no quiet-free minute exists within two days.
 */
function stretchEdge(
  at: Date,
  timeZone: string,
  windows: readonly QuietWindow[],
  direction: -1 | 1,
): Date | null {
  const coarse = 5 * MINUTE_MS * direction;
  const limit = 2 * 24 * 60 * MINUTE_MS;
  let t = floorToMinute(at.getTime());
  let walked = 0;
  while (inQuiet(new Date(t), timeZone, windows)) {
    t += coarse;
    walked += Math.abs(coarse);
    if (walked > limit) return null;
  }
  // t is now outside the stretch. Step back toward it a minute at a time.
  while (!inQuiet(new Date(t - MINUTE_MS * direction), timeZone, windows)) {
    t -= MINUTE_MS * direction;
  }
  return direction === -1 ? new Date(t + MINUTE_MS) : new Date(t);
}

/**
 * When a reminder for `asked` goes out so it never lands in quiet hours: just before the
 * quiet stretch opens or as it ends, whichever is closer to the time asked for, and
 * earlier on a tie. A late-evening ask goes a little before the evening closes; an
 * early-morning one goes as the morning opens. Earlier needs time left before the
 * stretch opens. Null: no quiet-free time could be found.
 */
export function quietSafeAt(
  asked: Date,
  now: Date,
  timeZone: string,
  windows: readonly QuietWindow[],
): { at: Date; moved: QuietShift } | null {
  if (!inQuiet(asked, timeZone, windows)) return { at: asked, moved: null };
  const options: { at: Date; moved: QuietShift }[] = [];
  const opened = stretchEdge(asked, timeZone, windows, -1);
  if (opened) {
    const floor = floorToMinute(now.getTime() + MIN_LEAD_MS + MINUTE_MS - 1);
    const early = new Date(Math.max(opened.getTime() - QUIET_EARLY_MARGIN_MS, floor));
    if (early.getTime() < opened.getTime() && !inQuiet(early, timeZone, windows)) {
      options.push({ at: early, moved: 'earlier' });
    }
  }
  const closed = stretchEdge(asked, timeZone, windows, 1);
  if (closed) options.push({ at: closed, moved: 'later' });
  const distance = (option: { at: Date }) => Math.abs(option.at.getTime() - asked.getTime());
  return options.reduce<{ at: Date; moved: QuietShift } | null>(
    (best, option) => (best === null || distance(option) < distance(best) ? option : best),
    null,
  );
}

/** The earliest quiet start among the phones that will read a group post. */
export function earliestQuietStart(starts: readonly string[], fallback: string): string {
  if (starts.length === 0) return fallback;
  return [...starts].sort()[0] ?? fallback;
}

export interface AskerStanding {
  /** Signed up with Hale themselves, not only seated through the group. */
  haleCustomer: boolean;
  /**
   * A 1:1 text from Hale can reach them right now: a parent of this family with live SMS
   * consent and reminders on, and the loop's sends switched on.
   */
  directReachable: boolean;
}

/**
 * Where a reminder is delivered. Only the asker's own reminder can ever go 1:1, and only
 * to a Hale customer: a reminder asked for by someone seated only through the group stays
 * in the group, whatever they asked (decision 2026-10-21). A reminder for someone else or
 * for everyone is a group post — nobody is texted 1:1 because someone else asked.
 */
export function deliveryFor(
  ask: Pick<ReminderAsk, 'for' | 'where'>,
  asker: AskerStanding,
): ReminderDelivery {
  if (ask.for !== 'sender') return 'group';
  if (!asker.haleCustomer) return 'group';
  if (ask.where === 'group') return 'group';
  return asker.directReachable ? 'direct' : 'group';
}

export type GroupReminderDropReason =
  | 'group_gone'
  | 'asker_gone'
  | 'recipient_gone'
  | 'missed'
  | 'audience_held'
  | 'asker_not_customer'
  | 'quiet_hours'
  | 'direct_unreachable';

export type FireDecision = { kind: 'send' } | { kind: 'drop'; reason: GroupReminderDropReason };

export interface FireState {
  now: Date;
  /** The family still holds this chat. */
  groupHeld: boolean;
  askerSeated: boolean;
  /** Null when the reminder names no seated person. */
  recipientSeated: boolean | null;
  /** The group may hear this line now. Read for a group delivery only. */
  audienceAllowed: boolean;
  /**
   * The asker still counts as a Hale customer, by the rule the reminder was set with.
   * Read for a direct delivery only.
   */
  askerCustomer: boolean;
  quietNow: boolean;
  /** Read for a direct delivery only. */
  directReachable: boolean;
}

/**
 * Whether a due reminder goes out. A STOP or a removal already cancelled it; this is the
 * check at the moment of sending, so a change since it was set still wins. A reminder is
 * never deferred into a stale one: a quiet-hours hit or a late tick drops it, by name.
 * A 1:1 reminder whose asker no longer counts as a Hale customer is dropped, not posted
 * in the group instead: they were told it would come privately.
 */
export function fireDecision(
  row: { deliverAt: Date; delivery: ReminderDelivery },
  state: FireState,
): FireDecision {
  if (!state.groupHeld) return { kind: 'drop', reason: 'group_gone' };
  if (!state.askerSeated) return { kind: 'drop', reason: 'asker_gone' };
  if (state.recipientSeated === false) return { kind: 'drop', reason: 'recipient_gone' };
  if (state.now.getTime() - row.deliverAt.getTime() > LATE_LIMIT_MS) {
    return { kind: 'drop', reason: 'missed' };
  }
  if (row.delivery === 'group' && !state.audienceAllowed) {
    return { kind: 'drop', reason: 'audience_held' };
  }
  if (row.delivery === 'direct' && !state.askerCustomer) {
    return { kind: 'drop', reason: 'asker_not_customer' };
  }
  if (state.quietNow) return { kind: 'drop', reason: 'quiet_hours' };
  if (row.delivery === 'direct' && !state.directReachable) {
    return { kind: 'drop', reason: 'direct_unreachable' };
  }
  return { kind: 'send' };
}

/**
 * A model-read first name matched to a seated member's first name: same letters, case
 * and accents aside. This resolves an identity the reader already extracted; it never
 * decides what anybody meant.
 */
export function sameFirstName(a: string, b: string): boolean {
  const fold = (s: string) =>
    s.normalize('NFD').replace(/\p{M}/gu, '').trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  const left = fold(a);
  return left !== '' && left === fold(b);
}
